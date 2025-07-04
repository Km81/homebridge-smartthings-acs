// index.js v1.0.6 (웹훅/인증 서버 – 내부 8999만 리슨)
'use strict';

const SmartThings = require('./lib/SmartThings');
const pkg = require('./package.json');
const http = require('http');
const url = require('url');
const https = require('https');

let Accessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'SmartThingsACs';
const PLUGIN_NAME = 'homebridge-smartthings-acs';
const INTERNAL_PORT = 8999;  // <-- 내부 포트 고정

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
      // 항상 내부 포트에서 서버 리슨 시작
      this.startWebhookServer();
      if (hasToken) {
        await this.discoverDevices();
      }
    });
  }

  startWebhookServer() {
    // 이미 열려 있으면 아무 작업 안 함
    if (this.server && this.server.listening) {
      this.log.warn(`웹훅/인증 서버가 이미 포트 ${INTERNAL_PORT}에서 리슨 중입니다.`);
      return;
    }
    // 이전 서버가 남아 있으면 닫기
    if (this.server) {
      try { this.server.close(); } catch (e) {}
      this.server = null;
    }

    const callbackPath = new url.URL(this.config.redirectUri).pathname;

    this.server = http.createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        const reqUrl = url.parse(req.url, true);

        // 인증 콜백(GET)
        if (req.method === 'GET' && reqUrl.pathname === callbackPath) {
          await this._handleOAuthCallback(req, res, reqUrl);
        }
        // 웹훅/스마트싱스 POST
        else if (req.method === 'POST') {
          this._handleWebhookConfirmation(req, res, body);
        }
        else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });
    }).listen(INTERNAL_PORT, () => {
      const scope = 'r:devices:* w:devices:* x:devices:*';
      const authUrl = `https://api.smartthings.com/oauth/authorize?client_id=${this.config.clientId}` +
                      `&scope=${encodeURIComponent(scope)}` +
                      `&response_type=code` +
                      `&redirect_uri=${encodeURIComponent(this.config.redirectUri)}`;
      this.log.warn('====================[ SmartThings 인증 & 웹훅 서버 ]====================');
      this.log.warn(`• 내부 포트 ${INTERNAL_PORT}에서 웹훅/인증 서버가 리슨 중입니다.`);
      this.log.warn('• 인증이 필요할 때 아래 URL을 브라우저에 입력하세요:');
      this.log.warn(`  ${authUrl}`);
      this.log.warn('• 인증 성공 후 창을 닫아도, 서버는 계속 웹훅을 수신합니다.');
      this.log.warn('===================================================================');
    });
    this.server.on('error', (e) => {
      this.log.error(`웹훅/인증 서버 오류: ${e.message}`);
      if (e.code === 'EADDRINUSE') {
        this.log.error(`포트 ${INTERNAL_PORT}가 이미 사용 중입니다. 다른 프로세스가 점유했는지 확인하세요.`);
      }
    });
  }

  async _handleOAuthCallback(req, res, reqUrl) {
    const code = reqUrl.query.code;
    if (code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>인증 성공!</h1><p>SmartThings 인증에 성공했습니다.<br>이 창은 닫아도 됩니다. 서버는 계속 웹훅을 수신합니다.</p>');
      try {
        await this.smartthings.getInitialTokens(code);
        this.log.info('최초 토큰 발급 완료! 서버는 계속 웹훅 대기 중입니다.');
      } catch (e) {
        this.log.error('토큰 발급 중 오류 발생:', e.message);
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
        const url = payload.confirmationData.confirmationUrl;
        this.log.info('Webhook CONFIRMATION 수신, 확인 URL 호출 중...');
        https.get(url, confirmRes => {
          this.log.info(`Webhook 확인 완료, 상태 코드: ${confirmRes.statusCode}`);
        }).on('error', e => {
          this.log.error(`Webhook 확인 요청 오류: ${e.message}`);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ targetUrl: this.config.redirectUri }));
      }
      else if (payload.lifecycle === 'EVENT') {
        for (const ev of payload.eventData.events) {
          if (ev.eventType === 'DEVICE_EVENT') {
            this.processDeviceEvent(ev.deviceEvent);
          }
        }
        res.writeHead(200).end();
      }
      else {
        res.writeHead(200).end();
      }
    } catch (e) {
      this.log.error('POST 요청 처리 오류:', e.message);
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
        if (service.getCharacteristic(Characteristic.Active).value === 1) {
          let state;
          switch (value) {
            case 'cool':
            case 'dry':
              state = Characteristic.CurrentHeaterCoolerState.COOLING; break;
            case 'heat':
              state = Characteristic.CurrentHeaterCoolerState.HEATING; break;
            default:
              state = Characteristic.CurrentHeaterCoolerState.IDLE;
          }
          service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, state);
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
      const devices = await this.smartthings.getDevices();
      this.log.info(`총 ${devices.length}개의 SmartThings 장치를 발견했습니다.`);
      for (const cfg of this.config.devices) {
        const label = normalizeKorean(cfg.deviceLabel);
        const found = devices.find(d => normalizeKorean(d.label) === label);
        if (found) this.addOrUpdateAccessory(found, cfg);
        else this.log.warn(`장치 '${cfg.deviceLabel}'를 찾지 못했습니다.`);
      }
    } catch (e) {
      this.log.error('장치 검색 중 오류:', e.message);
    }
  }

  addOrUpdateAccessory(device, cfg) {
    const uuid = UUIDGen.generate(device.deviceId);
    let acc = this.accessories.get(uuid);
    if (acc) {
      this.log.info(`기존 액세서리 갱신: ${device.label}`);
      acc.context.device = device;
      acc.context.configDevice = cfg;
    } else {
      this.log.info(`새 액세서리 등록: ${device.label}`);
      acc = new this.api.platformAccessory(device.label, uuid);
      acc.context.device = device;
      acc.context.configDevice = cfg;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    }
    this.accessories.set(uuid, acc);

    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(Characteristic.Model, cfg.model || 'AC-Model')
      .setCharacteristic(Characteristic.SerialNumber, cfg.serialNumber || device.deviceId)
      .setCharacteristic(Characteristic.FirmwareRevision, pkg.version);

    this.setupHeaterCoolerService(acc);
  }

  _bindCharacteristic({ service, characteristic, props, getter, setter }) {
    const char = service.getCharacteristic(characteristic);
    char.removeAllListeners('get');
    if (setter) char.removeAllListeners('set');
    if (props) char.setProps(props);

    char.on('get', async callback => {
      try {
        const val = await getter();
        callback(null, val);
      } catch (e) {
        this.log.error(`[${service.displayName}] GET 오류 (${characteristic.displayName}):`, e.message);
        callback(e);
      }
    });

    if (setter) {
      char.on('set', async (val, callback) => {
        try {
          await setter(val);
          callback(null);
        } catch (e) {
          this.log.error(`[${service.displayName}] SET 오류 (${characteristic.displayName}):`, e.message);
          callback(e);
        }
      });
    }
  }

  setupHeaterCoolerService(acc) {
    const deviceId = acc.context.device.deviceId;
    const svc = acc.getService(Service.HeaterCooler) || acc.addService(Service.HeaterCooler, acc.displayName);
    const getStatus = (cap, attr, def) => async () => {
      const s = await this.smartthings.getStatus(deviceId);
      const key = cap.split('.').pop();
      return s[key]?.[attr]?.value ?? def;
    };
    const CAP = {
      OPTIONAL_MODE: 'custom.airConditionerOptionalMode',
      AUTO_CLEANING: 'custom.autoCleaningMode'
    };

    this._bindCharacteristic({
      service: svc,
      characteristic: Characteristic.Active,
      getter: async () => await getStatus('switch','switch','off')() === 'on' ? 1 : 0,
      setter: v => this.smartthings.sendCommand(deviceId,{component:'main',capability:'switch',command:v===1?'on':'off'})
    });

    this._bindCharacteristic({
      service: svc,
      characteristic: Characteristic.CurrentHeaterCoolerState,
      getter: async () => {
        const power = await getStatus('switch','switch','off')();
        if (power==='off') return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        const mode = await getStatus('airConditionerMode','airConditionerMode','off')();
        switch(mode){
          case 'cool': case 'dry': return Characteristic.CurrentHeaterCoolerState.COOLING;
          case 'heat': return Characteristic.CurrentHeaterCoolerState.HEATING;
          default: return Characteristic.CurrentHeaterCoolerState.IDLE;
        }
      }
    });

    this._bindCharacteristic({
      service: svc,
      characteristic: Characteristic.TargetHeaterCoolerState,
      props: { validValues: [Characteristic.TargetHeaterCoolerState.COOL] },
      getter: () => Characteristic.TargetHeaterCoolerState.COOL,
      setter: async v => {
        if (v===Characteristic.TargetHeaterCoolerState.COOL) {
          await this.smartthings.sendCommand(deviceId,{
            component:'main',capability:'airConditionerMode',
            command:'setAirConditionerMode',arguments:['dry']
          });
        }
      }
    });

    this._bindCharacteristic({
      service: svc,
      characteristic: Characteristic.CurrentTemperature,
      getter: getStatus('temperatureMeasurement','temperature',20)
    });

    this._bindCharacteristic({
      service: svc,
      characteristic: Characteristic.CoolingThresholdTemperature,
      props: {minValue:18,maxValue:30,minStep:1},
      getter: getStatus('thermostatCoolingSetpoint','coolingSetpoint',24),
      setter: v => this.smartthings.sendCommand(deviceId,{
        component:'main',capability:'thermostatCoolingSetpoint',
        command:'setCoolingSetpoint',arguments:[v]
      })
    });

    this._bindCharacteristic({
      service: svc,
      characteristic: Characteristic.SwingMode,
      getter: async () => await getStatus(CAP.OPTIONAL_MODE,'acOptionalMode','off')() === 'windFree' ? 1 : 0,
      setter: v => this.smartthings.sendCommand(deviceId,{
        component:'main',capability:CAP.OPTIONAL_MODE,
        command:'setAcOptionalMode',arguments:[v===1?'windFree':'off']
      })
    });

    this._bindCharacteristic({
      service: svc,
      characteristic: Characteristic.LockPhysicalControls,
      getter: async () => await getStatus(CAP.AUTO_CLEANING,'autoCleaningMode','off')() === 'on' ? 1 : 0,
      setter: v => this.smartthings.sendCommand(deviceId,{
        component:'main',capability:CAP.AUTO_CLEANING,
        command:'setAutoCleaningMode',arguments:[v===1?'on':'off']
      })
    });
  }
}
