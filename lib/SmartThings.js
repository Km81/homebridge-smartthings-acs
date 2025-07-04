// lib/SmartThings.js v1.1.3
'use strict';

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { LRUCache } = require('lru-cache');
const axiosRetry = require('axios-retry').default;

class SmartThings {
    constructor(log, api, config) {
        this.log = log;
        this.api = api;
        this.config = config;
        this.tokenPath = path.join(this.api.user.persistPath(), 'smartthings_token.json');
        this.appInfoPath = path.join(this.api.user.persistPath(), 'smartthings_acs_app_info.json');
        this.tokens = null;
        this.installedAppId = null;
        this.isRefreshing = false;
        this.pendingRequests = [];

        this.client = axios.create({
            baseURL: 'https://api.smartthings.com/v1',
            timeout: 10000,
        });
        
        axiosRetry(this.client, {
            retries: 3,
            retryDelay: (retryCount, error) => {
                this.log.info(`API 요청 재시도 (${retryCount}번째)... 오류: ${error.message}`);
                return axiosRetry.exponentialDelay(retryCount, error, 1000);
            },
            retryCondition: (error) => {
                const status = error.response?.status;
                return axios.isAxiosError(error) && (axiosRetry.isNetworkOrIdempotentRequestError(error) || status >= 500 || status === 429);
            }
        });

        this.setupInterceptors();
        this.cache = new LRUCache({ max: 100, ttl: 1000 * 10 });
        this.statusPromises = new Map();
    }
    
    setupInterceptors() {
        this.client.interceptors.request.use(
            async (config) => {
                if (!this.tokens) await this.init();
                
                if (this.tokens?.expires_at && Date.now() >= this.tokens.expires_at) {
                    await this.refreshToken();
                }

                if (this.tokens?.access_token) {
                    config.headers.Authorization = `Bearer ${this.tokens.access_token}`;
                }
                return config;
            },
            error => Promise.reject(error)
        );
    }

    onRefreshed(err, newAccessToken) {
        this.pendingRequests.forEach(({ resolve, reject }) => err ? reject(err) : resolve(newAccessToken));
        this.pendingRequests = [];
    }

    async init() {
        try {
            this.tokens = JSON.parse(await fs.readFile(this.tokenPath, 'utf8'));
            const appInfo = JSON.parse(await fs.readFile(this.appInfoPath, 'utf8'));
            this.installedAppId = appInfo.installedAppId;
            this.log.info('저장된 OAuth 토큰 및 App 정보를 성공적으로 불러왔습니다.');
            return true;
        } catch (e) {
            this.log.warn('저장된 토큰 또는 App 정보가 없습니다. 사용자 인증이 필요합니다.');
            return false;
        }
    }

    async getInitialTokens(code) {
        this.log.info('인증 코드를 사용하여 첫 토큰 발급을 시도합니다...');
        const tokenUrl = 'https://api.smartthings.com/oauth/token';
        const authHeader = 'Basic ' + Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
        try {
            const response = await axios.post(tokenUrl, new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: this.config.redirectUri,
                client_id: this.config.clientId,
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': authHeader,
                },
            });
            await this.saveTokens(response.data);
        } catch (e) {
            this.log.error(`초기 토큰 발급 실패: ${e.response?.status}`, e.response?.data || e.message);
            throw new Error('초기 토큰 발급에 실패했습니다.');
        }
    }

    async refreshToken() {
        if (!this.tokens?.refresh_token) throw new Error('리프레시 토큰이 없어 갱신할 수 없습니다.');
        if (this.isRefreshing) {
            return new Promise((resolve, reject) => this.pendingRequests.push({ resolve, reject }));
        }
        this.isRefreshing = true;
        this.log.info('액세스 토큰 갱신을 시도합니다...');
        const tokenUrl = 'https://api.smartthings.com/oauth/token';
        const authHeader = 'Basic ' + Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
        try {
            const response = await axios.post(tokenUrl, new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: this.tokens.refresh_token,
                client_id: this.config.clientId,
            }), {
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });
            await this.saveTokens(response.data);
            this.isRefreshing = false;
            this.onRefreshed(null, this.tokens.access_token);
            return this.tokens.access_token;
        } catch (error) {
            this.isRefreshing = false;
            this.onRefreshed(error, null);
            this.log.error(`토큰 갱신 실패:`, error.message);
            throw error;
        }
    }

    async saveTokens(tokens) {
        try {
            tokens.expires_at = Date.now() + ((tokens.expires_in || 3600) * 1000) - 60000;
            this.tokens = tokens;
            await fs.writeFile(this.tokenPath, JSON.stringify(this.tokens, null, 2), 'utf8');
            this.log.info('토큰을 성공적으로 저장/갱신했습니다.');
        } catch (e) {
            this.log.error('토큰 파일 저장 중 오류 발생:', e.message);
        }
    }

    async saveAppInfo(appId, installedAppId) {
        this.installedAppId = installedAppId;
        const appInfo = { appId, installedAppId };
        await fs.writeFile(this.appInfoPath, JSON.stringify(appInfo, null, 2), 'utf8');
        this.log.info(`App 정보 저장 완료 (InstalledAppId: ${installedAppId})`);
    }

    async createSubscription(deviceId, capability) {
        if (!this.installedAppId) {
            this.log.error('installedAppId가 없어 구독을 생성할 수 없습니다.');
            return;
        }
        try {
            const body = { sourceType: 'CAPABILITY', capability: { deviceId, capability, stateChangeOnly: true } };
            await this.client.post(`/installedapps/${this.installedAppId}/subscriptions`, body);
            this.log.info(`[${deviceId.slice(-4)}] ${capability} 이벤트 구독 신청 성공`);
        } catch (e) {
            if (e.response?.status !== 409) {
                this.log.error(`[${deviceId.slice(-4)}] ${capability} 이벤트 구독 실패:`, e.response?.data || e.message);
            }
        }
    }

    async getDevices() {
        const { data } = await this.client.get('/devices');
        return data.items || [];
    }

    async getStatus(deviceId) {
        const cacheKey = `status-${deviceId}`;
        const cachedData = this.cache.get(cacheKey);
        if (cachedData) return cachedData;
        
        if (this.statusPromises.has(deviceId)) {
            return this.statusPromises.get(deviceId);
        }
        const promise = this.client.get(`/devices/${deviceId}/status`)
            .then(res => {
                const data = res.data.components.main;
                this.cache.set(cacheKey, data);
                return data;
            })
            .catch(e => {
                this.log.error(`[${deviceId}] 상태 조회 실패:`, e.message);
                throw new Error(`[${deviceId}] 상태 조회에 실패했습니다.`);
            })
            .finally(() => {
                this.statusPromises.delete(deviceId);
            });
        this.statusPromises.set(deviceId, promise);
        return promise;
    }

    updateDeviceStatusCache(deviceId, capability, attribute, value) {
        const cacheKey = `status-${deviceId}`;
        const cachedStatus = this.cache.get(cacheKey);
        if (cachedStatus) {
            if (!cachedStatus[capability]) cachedStatus[capability] = {};
            if (!cachedStatus[capability][attribute]) cachedStatus[capability][attribute] = {};
            cachedStatus[capability][attribute].value = value;
            this.cache.set(cacheKey, cachedStatus);
            this.log.info(`[캐시 업데이트] ${deviceId.slice(-4)} - ${capability}.${attribute} = ${value}`);
        }
    }

    async sendCommand(deviceId, command) {
        this.cache.delete(`status-${deviceId}`);
        const commands = Array.isArray(command) ? command : [command];
        await this.client.post(`/devices/${deviceId}/commands`, { commands });
        this.log.info(`[명령 전송] ID: ${deviceId}, 명령:`, JSON.stringify(commands));
    }
}

module.exports = SmartThings;
