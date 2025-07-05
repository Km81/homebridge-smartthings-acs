// index.js v1.1.3
'use strict';

const SmartThings = require('./lib/SmartThings');
const pkg = require('./package.json');
const http = require('http');
const url = require('url');
const https = require('https');

let Accessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'SmartThingsACs';
const PLUGIN_NAME = 'homebridge-smartthings-acs';
const INTERNAL_PORT = 8999;

const CAPABILITY = {
    SWITCH: 'switch',
    MODE: 'airConditionerMode',
    TEMP: 'temperatureMeasurement',
    SETPOINT: 'thermostatCoolingSetpoint',
    OPTIONAL_MODE: 'custom.airConditionerOptionalMode',
    AUTO_CLEANING: 'custom.autoCleaningMode',
};

const normalizeKorean = s => (s || '').normalize('NFC').trim();

module.exports = (homebridge) => {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;
    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SmartThingsACsPlatform);
};

class SmartThingsACsPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessories = new Map();
        this.server = null;

        if (!config || !config.clientId || !config.clientSecret || !config.redirectUri) {
            this.log.error('SmartThings 인증 정보(clientId, clientSecret, redirectUri)가 설정되지 않았습니다.');
            return;
        }

        this.smartthings = new SmartThings(this.log, this.api, this.config);

        this.api.on('didFinishLaunching', async () => {
            this.log.info('Homebridge 실행 완료. 인증 및 장치 검색 시작.');
            const hasToken = await this.smartthings.init();
            this.startServer(hasToken);
            if (hasToken) {
                await this.discoverDevices();
            }
        });
    }

    configureAccessory(accessory) {
        this.log.info(`캐시된 액세서리 불러오기: ${accessory.displayName}`);
        this.accessories.set(accessory.UUID, accessory);
    }
    
    startServer(hasToken) {
        if (this.server?.listening) {
            this.log.info(`웹훅/인증 서버가 이미 포트 ${INTERNAL_PORT}에서 실행 중입니다.`);
            return;
        }

        const callbackPath = new url.URL(this.config.redirectUri).pathname;

        this.server = http.createServer(async (req, res) => {
            const reqUrl = url.parse(req.url, true);
            if (req.method === 'GET' && reqUrl.pathname === callbackPath) {
                await this._handleOAuthCallback(req, res, reqUrl);
            } else if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', () => this._handleWebhook(req, res, body));
            } else {
                res.writeHead(404).end('Not Found');
            }
        }).listen(INTERNAL_PORT, () => {
            if (hasToken) {
                this.log.info(`[서버] 기존 인증 정보를 확인했습니다. 내부 포트 ${INTERNAL_PORT}에서 실시간 웹훅 수신 대기 중입니다.`);
            } else {
                const scope = 'r:devices:* w:devices:* x:devices:*';
                const authUrl = `https://api.smartthings.com/oauth/authorize?client_id=${this.config.clientId}&scope=${encodeURIComponent(scope)}&response_type=code&redirect_uri=${encodeURIComponent(this.config.redirectUri)}`;
                this.log.warn('====================[ 스마트싱스 인증 필요 ]====================');
                this.log.warn(`• 내부 포트 ${INTERNAL_PORT}에서 인증 서버가 실행 중입니다.`);
                this.log.warn('• 아래 URL을 브라우저에 입력하여 권한을 허용해주세요:');
                this.log.warn(`  ${authUrl}`);
                this.log.warn('================================================================');
            }
        });
        this.server.on('error', (e) => {
            this.log.error(`웹훅/인증 서버 오류: ${e.message}`);
            if (e.code === 'EADDRINUSE') {
                this.log.error(`포트 ${INTERNAL_PORT}가 이미 사용 중입니다.`);
            }
        });
    }

    async _handleOAuthCallback(req, res, reqUrl) {
        const code = reqUrl.query.code;
        if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>인증 성공!</h1><p>SmartThings 인증에 성공했습니다. 이 창을 닫고 Homebridge를 재시작해주세요.</p>');
            try {
                await this.smartthings.getInitialTokens(code);
                this.log.info('최초 토큰 발급 완료! Homebridge를 재시작하면 장치가 연동됩니다.');
            } catch (e) {
                this.log.error('수신된 코드로 토큰 발급 중 오류 발생:', e.message);
            }
        } else {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>인증 실패</h1>');
        }
    }
    
    async _handleWebhook(req, res, body) {
        try {
            const payload = JSON.parse(body);
            if (payload.lifecycle === 'CONFIRMATION') {
                const { appId, installedAppId, confirmationUrl } = payload.confirmationData;
                await this.smartthings.saveAppInfo(appId, installedAppId);
                https.get(confirmationUrl, (confRes) => {
                    this.log.info(`Webhook CONFIRMATION 요청 확인 완료 (상태코드: ${confRes.statusCode})`);
                }).on('error', (e) => this.log.error(`Webhook 확인 요청 오류: ${e.message}`));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ "targetUrl": this.config.redirectUri }));
            } else if (payload.lifecycle === 'EVENT') {
                for (const event of payload.eventData.events) {
                    if (event.eventType === 'DEVICE_EVENT') {
                        this.processDeviceEvent(event.deviceEvent);
                    }
                }
                res.writeHead(200).end();
            } else {
                res.writeHead(200).end();
            }
        } catch (e) {
            this.log.error('Webhook 요청 처리 중 오류:', e.message);
            res.writeHead(400).end();
        }
    }
    
    processDeviceEvent({ deviceId, capability, attribute, value }) {
        const uuid = UUIDGen.generate(deviceId);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        this.log.info(`[실시간 업데이트] ${accessory.displayName} | ${capability}.${attribute} -> ${value}`);
        this.smartthings.updateDeviceStatusCache(deviceId, capability, attribute, value);
        
        const service = accessory.getService(Service.HeaterCooler);
        if (!service) return;

        switch (`${capability}.${attribute}`) {
            case 'switch.switch':
                service.updateCharacteristic(Characteristic.Active, value === 'on' ? 1 : 0);
                break;
            case 'airConditionerMode.airConditionerMode':
                 if(service.getCharacteristic(Characteristic.Active).value === 1) {
                    let currentState;
                    switch (value) {
                        case 'cool': case 'dry':
                            currentState = Characteristic.CurrentHeaterCoolerState.COOLING; break;
                        case 'heat':
                            currentState = Characteristic.CurrentHeaterCoolerState.HEATING; break;
                        default:
                            currentState = Characteristic.CurrentHeaterCoolerState.IDLE;
                    }
                    service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, currentState);
                 }
                break;
            case 'temperatureMeasurement.temperature':
                service.updateCharacteristic(Characteristic.CurrentTemperature, value);
                break;
            case 'thermostatCoolingSetpoint.coolingSetpoint':
                service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, value);
                break;
            case CAPABILITY.OPTIONAL_MODE + '.acOptionalMode':
                service.updateCharacteristic(Characteristic.SwingMode, value === 'windFree' ? 1 : 0);
                break;
            case CAPABILITY.AUTO_CLEANING + '.autoCleaningMode':
                service.updateCharacteristic(Characteristic.LockPhysicalControls, value === 'on' ? 1 : 0);
                break;
        }
    }

    async discoverDevices() {
        try {
            const stDevices = await this.smartthings.getDevices();
            this.log.info(`총 ${stDevices.length}개의 SmartThings 장치를 발견했습니다.`);
            
            for (const configDevice of this.config.devices) {
                const targetLabel = normalizeKorean(configDevice.deviceLabel);
                const foundDevice = stDevices.find(stDevice => normalizeKorean(stDevice.label) === targetLabel);
                if (foundDevice) {
                    this.addOrUpdateAccessory(foundDevice, configDevice);
                } else {
                    this.log.warn(`'${configDevice.deviceLabel}'에 해당하는 장치를 SmartThings에서 찾지 못했습니다.`);
                }
            }
        } catch(e) {
            this.log.error('장치 검색 중 오류:', e.message);
        }
    }

    async addOrUpdateAccessory(device, configDevice) {
        const uuid = UUIDGen.generate(device.deviceId);
        let accessory = this.accessories.get(uuid);

        if (accessory) {
            this.log.info(`기존 액세서리 갱신: ${device.label}`);
            accessory.context.device = device;
            accessory.context.configDevice = configDevice;
        } else {
            this.log.info(`새 액세서리 등록: ${device.label}`);
            accessory = new this.api.platformAccessory(device.label, uuid);
            accessory.context.device = device;
            accessory.context.configDevice = configDevice;
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
        this.accessories.set(uuid, accessory);

        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
            .setCharacteristic(Characteristic.Model, configDevice.model || 'AC-Model')
            .setCharacteristic(Characteristic.SerialNumber, configDevice.serialNumber || device.deviceId)
            .setCharacteristic(Characteristic.FirmwareRevision, pkg.version);

        this.setupHeaterCoolerService(accessory);
        await this.subscribeToEvents(device, configDevice);
    }
    
    async subscribeToEvents(device, configDevice) {
        this.log.info(`[${device.label}] 실시간 업데이트를 위한 이벤트 구독을 시작합니다.`);
        const capabilitiesToSubscribe = [CAPABILITY.SWITCH, CAPABILITY.MODE, CAPABILITY.TEMP, CAPABILITY.SETPOINT];
        if (configDevice.enableWindFree) {
            capabilitiesToSubscribe.push(CAPABILITY.OPTIONAL_MODE);
        }
        if (configDevice.enableAutoClean) {
            capabilitiesToSubscribe.push(CAPABILITY.AUTO_CLEANING);
        }
        for (const cap of capabilitiesToSubscribe) {
            await this.smartthings.createSubscription(device.deviceId, cap);
        }
    }

    _bindCharacteristic({ service, characteristic, props, getter, setter }) {
        const char = service.getCharacteristic(characteristic);
        char.removeAllListeners('get');
        if(setter) char.removeAllListeners('set');
        if (props) char.setProps(props);
        
        char.on('get', async (callback) => {
            try {
                const value = await getter();
                callback(null, value);
            } catch (e) {
                this.log.error(`[${service.displayName}] GET 오류 (${characteristic.displayName}): ${e.message}. 기본값으로 처리합니다.`);
                switch(characteristic) {
                    case Characteristic.Active: callback(null, 0); break;
                    case Characteristic.CurrentHeaterCoolerState: callback(null, Characteristic.CurrentHeaterCoolerState.INACTIVE); break;
                    case Characteristic.TargetHeaterCoolerState: callback(null, Characteristic.TargetHeaterCoolerState.AUTO); break;
                    case Characteristic.CurrentTemperature: callback(null, 0); break;
                    case Characteristic.CoolingThresholdTemperature: callback(null, 18); break;
                    case Characteristic.SwingMode: callback(null, 0); break;
                    case Characteristic.LockPhysicalControls: callback(null, 0); break;
                    default: callback(e);
                }
            }
        });

        if (setter) {
            char.on('set', async (value, callback) => {
                try {
                    await setter(value);
                    callback(null);
                } catch (e) {
                    this.log.error(`[${service.displayName}] SET 오류 (${characteristic.displayName}):`, e.message);
                    callback(e);
                }
            });
        }
    }

    setupHeaterCoolerService(accessory) {
        const deviceId = accessory.context.device.deviceId;
        const configDevice = accessory.context.configDevice;
        const service = accessory.getService(Service.HeaterCooler) ||
            accessory.addService(Service.HeaterCooler, accessory.displayName);
        
        const getStatus = (capability, attribute, defaultValue) => async () => {
            const status = await this.smartthings.getStatus(deviceId);
            return status[capability]?.[attribute]?.value ?? defaultValue;
        };
        
        this._bindCharacteristic({ service, characteristic: Characteristic.Active,
            getter: async () => await getStatus('switch', 'switch', 'off')() === 'on' ? 1 : 0,
            setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: 'switch', command: value === 1 ? 'on' : 'off'}),
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.CurrentHeaterCoolerState,
            getter: async () => {
                const power = await getStatus('switch', 'switch', 'off')();
                if (power === 'off') return Characteristic.CurrentHeaterCoolerState.INACTIVE;
                const mode = await getStatus('airConditionerMode', 'airConditionerMode', 'off')();
                switch (mode) {
                    case 'cool': case 'dry': return Characteristic.CurrentHeaterCoolerState.COOLING;
                    case 'heat': return Characteristic.CurrentHeaterCoolerState.HEATING;
                    default: return Characteristic.CurrentHeaterCoolerState.IDLE;
                }
            },
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.TargetHeaterCoolerState,
            props: { validValues: [Characteristic.TargetHeaterCoolerState.AUTO, Characteristic.TargetHeaterCoolerState.HEAT, Characteristic.TargetHeaterCoolerState.COOL] },
            getter: async () => {
                const mode = await getStatus('airConditionerMode', 'airConditionerMode', 'auto')();
                 switch (mode) {
                    case 'cool': case 'dry': return Characteristic.TargetHeaterCoolerState.COOL;
                    case 'heat': return Characteristic.TargetHeaterCoolerState.HEAT;
                    default: return Characteristic.TargetHeaterCoolerState.AUTO;
                }
            },
            setter: async (value) => {
                let mode;
                switch (value) {
                    case Characteristic.TargetHeaterCoolerState.COOL: mode = 'cool'; break;
                    case Characteristic.TargetHeaterCoolerState.HEAT: mode = 'heat'; break;
                    case Characteristic.TargetHeaterCoolerState.AUTO: mode = 'auto'; break;
                }
                if (mode) await this.smartthings.sendCommand(deviceId, {component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: [mode]});
            },
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.CurrentTemperature,
            getter: getStatus('temperatureMeasurement', 'temperature', 20),
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.CoolingThresholdTemperature,
            props: { minValue: 18, maxValue: 30, minStep: 1 },
            getter: getStatus('thermostatCoolingSetpoint', 'coolingSetpoint', 24),
            setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [value]}),
        });
        
        if (configDevice.enableWindFree) {
            this.log.info(`[${accessory.displayName}] 무풍(스윙) 기능을 활성화합니다.`);
            this._bindCharacteristic({ service, characteristic: Characteristic.SwingMode,
                getter: async () => await getStatus(CAPABILITY.OPTIONAL_MODE, 'acOptionalMode', 'off')() === 'windFree' ? 1 : 0,
                setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: CAPABILITY.OPTIONAL_MODE, command: 'setAcOptionalMode', arguments: [value === 1 ? 'windFree' : 'off']}),
            });
        } else {
            if (service.testCharacteristic(Characteristic.SwingMode)) {
                service.removeCharacteristic(service.getCharacteristic(Characteristic.SwingMode));
            }
        }

        if (configDevice.enableAutoClean) {
            this.log.info(`[${accessory.displayName}] 자동 건조(잠금) 기능을 활성화합니다.`);
            this._bindCharacteristic({ service, characteristic: Characteristic.LockPhysicalControls,
                getter: async () => await getStatus(CAPABILITY.AUTO_CLEANING, 'autoCleaningMode', 'off')() === 'on' ? 1 : 0,
                setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: CAPABILITY.AUTO_CLEANING, command: 'setAutoCleaningMode', arguments: [value === 1 ? 'on' : 'off']}),
            });
        } else {
            if (service.testCharacteristic(Characteristic.LockPhysicalControls)) {
                service.removeCharacteristic(service.getCharacteristic(Characteristic.LockPhysicalControls));
            }
        }
    }
}
