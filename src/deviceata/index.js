import EventEmitter from 'events';
import MelCloudAta from '../melcloudata.js';
import Functions from '../functions.js';
import { DeviceType } from '../constants.js';
import { ExternalSensor } from './external-sensor.js';
import { StateParser } from './state-parser.js';
import { StateUpdater } from './state-updater.js';
import { ServiceFactory } from './services/index.js';
import { PredictiveController } from './predictive/index.js';
import { ThermalManager } from './thermal/index.js';
import { ActionExecutor } from './action-executor.js';

class DeviceAta extends EventEmitter {
    constructor(api, account, device, defaultTempsFile, accountInfo, accountFile, melcloud, melcloudDevicesList) {
        super();

        // HAP references stored in context
        this.api = api;
        this.Accessory = api.platformAccessory;
        this.Characteristic = api.hap.Characteristic;
        this.Service = api.hap.Service;
        this.Categories = api.hap.Categories;
        this.AccessoryUUID = api.hap.uuid;

        // Account config
        this.melcloud = melcloud;
        this.melcloudDevicesList = melcloudDevicesList;
        this.account = account;
        this.accountType = account.type;
        this.accountName = account.name;
        this.logDeviceInfo = account.log?.deviceInfo || false;
        this.logInfo = account.log?.info || false;
        this.logWarn = account.log?.warn || false;
        this.logDebug = account.log?.debug || false;

        // Device config
        this.device = device;
        this.deviceId = device.id;
        this.deviceName = device.name;
        this.deviceTypeString = DeviceType[device.type];
        this.displayType = device.displayType;
        this.heatDryFanMode = device.heatDryFanMode || 1;
        this.coolDryFanMode = device.coolDryFanMode || 1;
        this.autoDryFanMode = device.autoDryFanMode || 1;

        // External sensor config (required for predictive control)
        this.externalSensorConfig = device.externalSensor || {};
        this.externalSensorType = this.externalSensorConfig.type || 'shelly';
        this.compensationEnabled = true; // Always enabled in predictive mode
        this.hysteresis = 0.5;
        this.pollInterval = (this.externalSensorConfig.pollInterval || 60) * 1000;

        // Predictive control config
        this.targetTemperature = device.targetTemperature || 23;
        this.location = device.location || {};

        // InfluxDB config (optional)
        this.influxConfig = device.influxDb || {};
        this.influxEnabled = this.influxConfig.enabled || false;

        // External sensor state
        this.roomCurrentTemp = null;
        this.externalHumidity = null;
        this.temperatureOffset = 0;
        this.userTargetTemperature = null;
        this.lastCompensatedTarget = null;
        this.shellyClient = null;
        this.shellyPollingInterval = null;

        // Files
        this.defaultTempsFile = defaultTempsFile;
        this.accountInfo = accountInfo;
        this.accountFile = accountFile;

        // Utilities
        this.functions = new Functions(this.logWarn, this.logError, this.logDebug)
            .on('warn', warn => this.emit('warn', warn))
            .on('error', error => this.emit('error', error))
            .on('debug', debug => this.emit('debug', debug));

        // State
        this.displayDeviceInfo = true;
        this.deviceData = {};
        this.accessoryState = {};

        // Sub-modules
        this.externalSensor = new ExternalSensor(this);
        this.stateParser = new StateParser(this);
        this.stateUpdater = new StateUpdater(this);
        this.serviceFactory = new ServiceFactory(this);
        this.predictiveController = new PredictiveController(this);
        this.actionExecutor = new ActionExecutor(this);

        // Thermal manager (optional, created if InfluxDB enabled)
        this.thermalManager = this.influxEnabled ? new ThermalManager(this) : null;

        // Service references (populated during prepareAccessory)
        this.services = {};
    }

    async start() {
        try {
            // Create MelCloud device client
            this.melCloudAta = new MelCloudAta(this.account, this.device, this.defaultTempsFile, this.accountFile, this.melcloud)
                .on('deviceInfo', (modelIndoor, modelOutdoor, serialNumber, firmwareAppVersion) => {
                    if (this.logDeviceInfo && this.displayDeviceInfo) {
                        this.emit('devInfo', `---- ${this.deviceTypeString}: ${this.deviceName} ----`);
                        this.emit('devInfo', `Account: ${this.accountName}`);
                        if (modelIndoor) this.emit('devInfo', `Indoor: ${modelIndoor}`);
                        if (modelOutdoor) this.emit('devInfo', `Outdoor: ${modelOutdoor}`);
                        if (serialNumber) this.emit('devInfo', `Serial: ${serialNumber}`);
                        if (firmwareAppVersion) this.emit('devInfo', `Firmware: ${firmwareAppVersion}`);
                        this.emit('devInfo', `Manufacturer: Mitsubishi`);
                        this.emit('devInfo', '----------------------------------');
                        this.displayDeviceInfo = false;
                    }

                    // Accessory info
                    this.manufacturer = 'Mitsubishi';
                    this.model = modelIndoor ? modelIndoor : modelOutdoor ? modelOutdoor : `${this.deviceTypeString}`;
                    this.serialNumber = serialNumber.toString();
                    this.firmwareRevision = firmwareAppVersion.toString();

                    this.services.information?.setCharacteristic(this.Characteristic.FirmwareRevision, this.firmwareRevision);
                })
                .on('deviceState', async (deviceData) => {
                    this.deviceData = deviceData;

                    // Parse state
                    this.accessoryState = this.stateParser.parse(deviceData);

                    // Update external sensor offset
                    if (this.roomCurrentTemp !== null) {
                        const acCurrentTemp = deviceData?.Device?.RoomTemperature;
                        if (acCurrentTemp !== null && acCurrentTemp !== undefined) {
                            this.temperatureOffset = acCurrentTemp - this.roomCurrentTemp;
                        }
                    }

                    // Initialize user target from config target, NOT from AC's current setpoint
                    // The AC setpoint may be stale/wrong from previous manual adjustment
                    if (this.userTargetTemperature === null) {
                        this.userTargetTemperature = this.targetTemperature;
                        if (this.logInfo) this.emit('info', `User target temperature initialized to config value: ${this.targetTemperature}°C`);
                    }

                    // Update all services
                    this.stateUpdater.update();

                    // Process through predictive controller and execute actions
                    const stateResult = this.predictiveController.processStateUpdate(deviceData);
                    if (stateResult.action) {
                        await this.actionExecutor.executeAction(stateResult);
                    }

                    // Log data to thermal manager (if enabled)
                    if (this.thermalManager) {
                        this.thermalManager.logDataPoint(deviceData);
                    }

                    // Log current state
                    this.stateUpdater.logState();
                })
                .on('success', (success) => this.emit('success', success))
                .on('info', (info) => this.emit('info', info))
                .on('debug', (debug) => this.emit('debug', debug))
                .on('warn', (warn) => this.emit('warn', warn))
                .on('error', (error) => this.emit('error', error));

            // Start external sensor (required)
            await this.externalSensor.init();

            // Start predictive controller (required)
            await this.predictiveController.init();

            // Start thermal manager (optional, if InfluxDB enabled)
            if (this.thermalManager) {
                await this.thermalManager.init();
            }

            // Check state
            await this.melCloudAta.checkState(this.melcloudDevicesList);

            // Prepare accessory
            const accessory = await this.prepareAccessory();
            return accessory;
        } catch (error) {
            throw new Error(`Start error: ${error}`);
        }
    }

    async prepareAccessory() {
        try {
            if (this.logDebug) this.emit('debug', `Prepare accessory`);

            // Create accessory
            const accessoryName = this.deviceName;
            const accessoryUUID = this.AccessoryUUID.generate(this.accountName + this.deviceId.toString());
            const accessoryCategory = this.Categories.AIR_CONDITIONER;
            const accessory = new this.Accessory(accessoryName, accessoryUUID, accessoryCategory);

            // Create all services using factory
            this.services = await this.serviceFactory.createServices(accessory, accessoryName);

            return accessory;
        } catch (error) {
            throw new Error(`Prepare accessory error: ${error}`);
        }
    }
}

export default DeviceAta;
