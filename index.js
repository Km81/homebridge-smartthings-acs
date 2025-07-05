// index.js v1.0.7
'use strict';

const SmartThings = require('./lib/SmartThings');
const pkg = require('./package.json');
const http = require('http');
const url = require('url');
const https = require('https');

let Accessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'SmartThingsACs';
const PLUGIN_NAME = 'homebridge-smartthings-acs';

const CAP = {
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
            this.log.info('Homebridge 실행 완료. 인증 상태 확인 및 장치 검색을 시작합니다.');
            const hasToken = await this.smartthings.init();
            if (hasToken) {
                await this.discoverDevices();
            } else {
                this.startAuthServer();
            }
        });
    }

    startAuthServer() {
        if (this.server) {
            this.server.close();
        }
        const listenPort = 8999;
        this.server = http.createServer(async (req, res) => {
            const reqUrl = url.parse(req.url, true);
            if (req.method === 'GET' && reqUrl.pathname === new url.URL(this.config.redirectUri).pathname) {
                await this._handleOAuthCallback(req, res, reqUrl);
            } else if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', () => this._handleWebhookConfirmation(req, res, body));
            } else {
                res.writeHead(404, {'Content-Type': 'text/plain'}).end('Not Found');
            }
        }).listen(listenPort, () => {
            const scope = 'r:devices:* w:devices:* x:devices:*';
            const authUrl = `https://api.smartthings.com/oauth/authorize?client_id=${this.config.clientId}&scope=${encodeURIComponent(scope)}&response_type=code&redirect_uri=${encodeURIComponent(this.config.redirectUri)}`;
            this.log.warn('====================[ 스마트싱스 인증 필요 ]====================');
            this.log.warn(`1. 임시 인증 서버가 포트 ${listenPort}에서 실행 중입니다.`);
            this.log.warn('2. 아래 URL을 복사하여 웹 브라우저에서 열고, 스마트싱스에 로그인하여 권한을 허용해주세요.');
            this.log.warn(`인증 URL: ${authUrl}`);
            this.log.warn('================================================================');
        });
        this.server.on('error', (e) => { this.log.error(`인증 서버 오류: ${e.message}`); });
    }

    async _handleOAuthCallback(req, res, reqUrl) {
        const code = reqUrl.query.code;
        if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>인증 성공!</h1><p>이 창을 닫고 Homebridge를 재시작해주세요.</p>');
            try {
                await this.smartthings.getInitialTokens(code);
                this.log.info('최초 토큰 발급 완료! Homebridge를 재시작하면 장치가 연동됩니다.');
                if (this.server) this.server.close();
            } catch (e) {
                this.log.error('수신된 코드로 토큰 발급 중 오류 발생:', e.message);
            }
        } else {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>인증 실패</h1><p>URL에서 인증 코드를 찾을 수 없습니다.</p>');
        }
    }

    _handleWebhookConfirmation(req, res, body) {
        try {
            const payload = JSON.parse(body);
            if (payload.lifecycle === 'CONFIRMATION' && payload.confirmationData?.confirmationUrl) {
                const confirmationUrl = payload.confirmationData.confirmationUrl;
                this.log.info('스마트싱스로부터 Webhook CONFIRMATION 요청을 수신했습니다...');
                https.get(confirmationUrl, (confirmRes) => {
                    this.log.info(`Webhook 확인 완료, 상태 코드: ${confirmRes.statusCode}`);
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
            this.log.error('POST 요청 처리 중 오류:', e.message);
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
                            currentState = Characteristic.CurrentHeaterCoolerState.COOLING;
                            break;
                        case 'heat':
                            currentState = Characteristic.CurrentHeaterCoolerState.HEATING;
                            break;
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
            case 'custom.airConditionerOptionalMode.acOptionalMode':
                service.updateCharacteristic(Characteristic.SwingMode, value === 'windFree' ? 1 : 0);
                break;
            case 'custom.autoCleaningMode.autoCleaningMode':
                service.updateCharacteristic(Characteristic.LockPhysicalControls, value === 'on' ? 1 : 0);
                break;
        }
    }

    configureAccessory(accessory) {
        this.log.info(`캐시된 액세서리 불러오기: ${accessory.displayName}`);
        this.accessories.set(accessory.UUID, accessory);
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

    addOrUpdateAccessory(device, configDevice) {
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
    }
    
    _bindCharacteristic({ service, characteristic, props, getter, setter }) {
        const char = service.getCharacteristic(characteristic);
        char.removeAllListeners('get');
        if (setter) char.removeAllListeners('set');
        if (props) char.setProps(props);
        
        char.on('get', async (callback) => {
            try {
                const value = await getter();
                callback(null, value);
            } catch (e) {
                // <<< 개선점: 안정적인 오류 처리 >>>
                this.log.error(`[${service.displayName}] GET 오류 (${characteristic.displayName}): ${e.message}. 기본값으로 처리합니다.`);
                switch(characteristic) {
                    case Characteristic.Active:
                        callback(null, 0); break; // INACTIVE
                    case Characteristic.CurrentHeaterCoolerState:
                        callback(null, Characteristic.CurrentHeaterCoolerState.INACTIVE); break;
                    case Characteristic.CurrentTemperature:
                        callback(null, 0); break; // 0도
                    case Characteristic.CoolingThresholdTemperature:
                        callback(null, 18); break; // 최소 온도
                    case Characteristic.SwingMode:
                        callback(null, 0); break; // DISABLED
                    case Characteristic.LockPhysicalControls:
                        callback(null, 0); break; // DISABLED
                    default:
                        callback(e); // 그 외에는 에러 전달
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
        const service = accessory.getService(Service.HeaterCooler) ||
            accessory.addService(Service.HeaterCooler, accessory.displayName);
        
        const getStatus = (capability, attribute, defaultValue) => async () => {
            const status = await this.smartthings.getStatus(deviceId);
            const capKey = capability.split('.').pop();
            return status[capKey]?.[attribute]?.value ?? defaultValue;
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
            props: { validValues: [Characteristic.TargetHeaterCoolerState.COOL, Characteristic.TargetHeaterCoolerState.HEAT, Characteristic.TargetHeaterCoolerState.AUTO] },
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
                    case Characteristic.TargetHeaterCoolerState.COOL: mode = 'dry'; break;
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

        this._bindCharacteristic({ service, characteristic: Characteristic.SwingMode, // Wind-Free
            getter: async () => await getStatus(CAP.OPTIONAL_MODE, 'acOptionalMode', 'off')() === 'windFree' ? 1 : 0,
            setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: CAP.OPTIONAL_MODE, command: 'setAcOptionalMode', arguments: [value === 1 ? 'windFree' : 'off']}),
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.LockPhysicalControls, // Auto-Clean
            getter: async () => await getStatus(CAP.AUTO_CLEANING, 'autoCleaningMode', 'off')() === 'on' ? 1 : 0,
            setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: CAP.AUTO_CLEANING, command: 'setAutoCleaningMode', arguments: [value === 1 ? 'on' : 'off']}),
        });
    }
}
