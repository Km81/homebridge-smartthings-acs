// index.js v1.0.2
'use strict';

const SmartThings = require('./lib/SmartThings');
const pkg = require('./package.json');
const http = require('http');
const url = require('url');
const https = require('https');

let Accessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'SmartThingsACs';
const PLUGIN_NAME = 'homebridge-smartthings-acs';

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

        if (!config || !config.clientId || !config.clientSecret || !config.webhookUrl) {
            this.log.error('인증 정보(clientId, clientSecret, webhookUrl)가 모두 설정되어야 합니다.');
            return;
        }

        this.smartthings = new SmartThings(this.log, this.api, this.config);

        this.api.on('didFinishLaunching', async () => {
            this.log.info('Homebridge 실행 완료. 인증 및 장치 검색 시작.');
            const hasToken = await this.smartthings.init();
            if (hasToken) {
                await this.discoverDevices();
            }
            this.startServer();
        });
    }

    configureAccessory(accessory) {
        this.log.info(`캐시된 액세서리 불러오기: ${accessory.displayName}`);
        this.accessories.set(accessory.UUID, accessory);
    }
    
    startServer() {
        if (this.server) this.server.close();
        
        try {
            const serverUrl = new url.URL(this.config.webhookUrl);
            const listenPort = serverUrl.port || (serverUrl.protocol === 'https:' ? 443 : 80);
            const oauthCallbackPath = '/oauth/callback';

            this.server = http.createServer(async (req, res) => {
                const reqUrl = new url.URL(req.url, `${serverUrl.protocol}//${req.headers.host}`);
                
                if (req.method === 'GET' && reqUrl.pathname === oauthCallbackPath) {
                    await this._handleOAuthCallback(req, res, reqUrl);
                } else if (req.method === 'POST' && reqUrl.pathname === serverUrl.pathname) {
                    let body = '';
                    req.on('data', chunk => { body += chunk.toString(); });
                    req.on('end', () => this._handleWebhook(req, res, body));
                } else {
                    res.writeHead(404).end('Not Found');
                }
            }).listen(listenPort, () => {
                this.log.info(`인증 및 웹훅 수신 서버가 포트 ${listenPort}에서 실행 중입니다.`);
                if (!this.smartthings.tokens?.access_token) {
                    this.promptForAuth(oauthCallbackPath);
                }
            });
            this.server.on('error', (e) => { this.log.error(`서버 오류: ${e.message}`); });
        } catch (e) {
            this.log.error(`서버 URL (webhookUrl) 설정 오류: ${e.message}`);
        }
    }

    promptForAuth(callbackPath) {
        const redirectUri = new url.URL(callbackPath, this.config.webhookUrl).toString();
        const scope = 'r:devices:* x:devices:*';
        const authUrl = `https://api.smartthings.com/oauth/authorize?client_id=${this.config.clientId}&scope=${encodeURIComponent(scope)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`;
        this.log.warn('====================[ 스마트싱스 인증 필요 ]====================');
        this.log.warn('아래 URL에 접속하여 권한을 허용해주세요.');
        this.log.warn(`인증 URL: ${authUrl}`);
        this.log.warn('================================================================');
    }

    async _handleOAuthCallback(req, res, reqUrl) {
        const code = reqUrl.searchParams.get('code');
        if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>인증 성공!</h1><p>이 창을 닫고 Homebridge를 재시작해주세요.</p>');
            try {
                await this.smartthings.getInitialTokens(code);
                this.log.info('최초 토큰 발급 완료! Homebridge를 재시작하면 장치가 연동됩니다.');
                if (this.server) this.server.close();
            } catch (e) {
                this.log.error('토큰 발급 중 오류:', e.message);
            }
        } else {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>인증 실패</h1>');
        }
    }

    _handleWebhook(req, res, body) {
        try {
            const payload = JSON.parse(body);
            if (payload.lifecycle === 'CONFIRMATION') {
                const confirmationUrl = payload.confirmationData.confirmationUrl;
                https.get(confirmationUrl).on('error', (e) => this.log.error(`Webhook 확인 요청 오류: ${e.message}`));
                this.log.info('Webhook CONFIRMATION 요청을 수신하고 확인했습니다.');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ targetUrl: this.config.webhookUrl }));
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
    
    async discoverDevices() {
        try {
            const stDevices = await this.smartthings.getDevices();
            this.log.info(`총 ${stDevices.length}개의 SmartThings 장치를 발견했습니다.`);
            
            const configDevices = this.config.devices || [];
            for (const configDevice of configDevices) {
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

        // <<< 변경된 부분 >>>
        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
            .setCharacteristic(Characteristic.Model, configDevice.model || 'AC Model')
            .setCharacteristic(Characteristic.SerialNumber, configDevice.serialNumber || device.deviceId)
            .setCharacteristic(Characteristic.FirmwareRevision, pkg.version);

        this.setupHeaterCoolerService(accessory);
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
                this.log.error(`[${service.displayName}] ${characteristic.displayName} GET 오류:`, e.message);
                callback(e);
            }
        });

        if (setter) {
            char.on('set', async (value, callback) => {
                try {
                    await setter(value);
                    callback(null);
                } catch (e) {
                    this.log.error(`[${service.displayName}] ${characteristic.displayName} SET 오류:`, e.message);
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
            const capKey = capability.includes('.') ? capability : capability.split('.').pop();
            return status[capKey]?.[attribute]?.value ?? defaultValue;
        };
        
        const CAP = { OPTIONAL_MODE: 'custom.airConditionerOptionalMode', AUTO_CLEANING: 'custom.autoCleaningMode' };
        
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
            props: { validValues: [Characteristic.TargetHeaterCoolerState.COOL] },
            getter: () => Characteristic.TargetHeaterCoolerState.COOL,
            setter: async (value) => { if (value === Characteristic.TargetHeaterCoolerState.COOL) await this.smartthings.sendCommand(deviceId, {component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['dry']}); },
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.CurrentTemperature,
            getter: getStatus('temperatureMeasurement', 'temperature', 20),
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.CoolingThresholdTemperature,
            props: { minValue: 18, maxValue: 30, minStep: 1 },
            getter: getStatus('thermostatCoolingSetpoint', 'coolingSetpoint', 24),
            setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [value]}),
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.SwingMode,
            getter: async () => await getStatus(CAP.OPTIONAL_MODE, 'acOptionalMode', 'off')() === 'windFree' ? 1 : 0,
            setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: CAP.OPTIONAL_MODE, command: 'setAcOptionalMode', arguments: [value === 1 ? 'windFree' : 'off']}),
        });

        this._bindCharacteristic({ service, characteristic: Characteristic.LockPhysicalControls,
            getter: async () => await getStatus(CAP.AUTO_CLEANING, 'autoCleaningMode', 'off')() === 'on' ? 1 : 0,
            setter: (value) => this.smartthings.sendCommand(deviceId, {component: 'main', capability: CAP.AUTO_CLEANING, command: 'setAutoCleaningMode', arguments: [value === 1 ? 'on' : 'off']}),
        });
    }
}
