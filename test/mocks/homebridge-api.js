/**
 * Mock Homebridge API for testing DeviceAta
 */

// Mock Characteristic types with getter/setter tracking
function createCharacteristicMock(name) {
    return {
        name,
        _value: null,
        _getHandler: null,
        _setHandler: null,
        _props: {},
        onGet(handler) {
            this._getHandler = handler;
            return this;
        },
        onSet(handler) {
            this._setHandler = handler;
            return this;
        },
        setProps(props) {
            this._props = { ...this._props, ...props };
            return this;
        },
        updateValue(value) {
            this._value = value;
            return this;
        }
    };
}

// Mock Service with characteristics
function createServiceMock(name, subtype) {
    const characteristics = new Map();
    return {
        name,
        subtype,
        _characteristics: characteristics,
        _optionalCharacteristics: [],
        getCharacteristic(type) {
            const typeName = typeof type === 'string' ? type : type.name || type.toString();
            if (!characteristics.has(typeName)) {
                characteristics.set(typeName, createCharacteristicMock(typeName));
            }
            return characteristics.get(typeName);
        },
        setCharacteristic(type, value) {
            const char = this.getCharacteristic(type);
            char._value = value;
            return this;
        },
        setPrimaryService(value) {
            this._isPrimaryService = value;
            return this;
        },
        addOptionalCharacteristic(type) {
            this._optionalCharacteristics.push(type);
            return this;
        }
    };
}

// Characteristic constants
export const Characteristic = {
    // Values
    Active: { name: 'Active', ACTIVE: 1, INACTIVE: 0 },
    CurrentHeaterCoolerState: { name: 'CurrentHeaterCoolerState', INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 },
    TargetHeaterCoolerState: { name: 'TargetHeaterCoolerState', AUTO: 0, HEAT: 1, COOL: 2 },
    CurrentHeatingCoolingState: { name: 'CurrentHeatingCoolingState', OFF: 0, HEAT: 1, COOL: 2 },
    TargetHeatingCoolingState: { name: 'TargetHeatingCoolingState', OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 },
    CurrentTemperature: { name: 'CurrentTemperature' },
    TargetTemperature: { name: 'TargetTemperature' },
    CoolingThresholdTemperature: { name: 'CoolingThresholdTemperature' },
    HeatingThresholdTemperature: { name: 'HeatingThresholdTemperature' },
    RotationSpeed: { name: 'RotationSpeed' },
    SwingMode: { name: 'SwingMode', SWING_DISABLED: 0, SWING_ENABLED: 1 },
    LockPhysicalControls: { name: 'LockPhysicalControls' },
    TemperatureDisplayUnits: { name: 'TemperatureDisplayUnits', CELSIUS: 0, FAHRENHEIT: 1 },
    On: { name: 'On' },
    StatusFault: { name: 'StatusFault' },
    ContactSensorState: { name: 'ContactSensorState', CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 },
    MotionDetected: { name: 'MotionDetected' },
    OccupancyDetected: { name: 'OccupancyDetected' },
    ConfiguredName: { name: 'ConfiguredName' },
    Manufacturer: { name: 'Manufacturer' },
    Model: { name: 'Model' },
    SerialNumber: { name: 'SerialNumber' },
    FirmwareRevision: { name: 'FirmwareRevision' }
};

// Service types
export const Service = {
    AccessoryInformation: function(name, subtype) { return createServiceMock('AccessoryInformation', subtype); },
    HeaterCooler: function(name, subtype) { return createServiceMock('HeaterCooler', subtype); },
    Thermostat: function(name, subtype) { return createServiceMock('Thermostat', subtype); },
    TemperatureSensor: function(name, subtype) { return createServiceMock('TemperatureSensor', subtype); },
    ContactSensor: function(name, subtype) { return createServiceMock('ContactSensor', subtype); },
    MotionSensor: function(name, subtype) { return createServiceMock('MotionSensor', subtype); },
    OccupancySensor: function(name, subtype) { return createServiceMock('OccupancySensor', subtype); },
    Switch: function(name, subtype) { return createServiceMock('Switch', subtype); }
};

// Accessory Categories
export const Categories = {
    AIR_CONDITIONER: 21
};

// UUID generator
export const uuid = {
    generate(input) {
        // Simple hash for testing
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            hash = ((hash << 5) - hash) + input.charCodeAt(i);
            hash |= 0;
        }
        return `uuid-${Math.abs(hash).toString(16)}`;
    }
};

// Platform Accessory mock
export class PlatformAccessory {
    constructor(name, uuid, category) {
        this.name = name;
        this.uuid = uuid;
        this.category = category;
        this._services = new Map();

        // Add default AccessoryInformation service
        const infoService = createServiceMock('AccessoryInformation', null);
        this._services.set('AccessoryInformation', infoService);
    }

    getService(serviceType) {
        const typeName = typeof serviceType === 'function' ? serviceType.name || 'Service' : serviceType;
        if (typeName === 'AccessoryInformation' || serviceType === Service.AccessoryInformation) {
            return this._services.get('AccessoryInformation');
        }
        return this._services.get(typeName);
    }

    addService(service) {
        this._services.set(service.name + (service.subtype || ''), service);
        return service;
    }
}

// Create the full mock API object
export function createMockApi() {
    return {
        platformAccessory: PlatformAccessory,
        hap: {
            Characteristic,
            Service,
            Categories,
            uuid
        },
        user: {
            storagePath() {
                return '/tmp/homebridge-test';
            }
        },
        on(event, callback) {
            // Store callback for later triggering if needed
            this._events = this._events || {};
            this._events[event] = callback;
        },
        registerPlatform() {},
        publishExternalAccessories() {}
    };
}

export default createMockApi;
