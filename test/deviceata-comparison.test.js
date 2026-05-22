/**
 * Integration tests for DeviceAta - verifies state parsing produces expected results
 *
 * These tests verify that the DeviceAta implementation correctly parses MELCloud
 * device data into HomeKit-compatible state.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// Import DeviceAta implementation
import DeviceAta from '../src/deviceata/index.js';
import { AirConditioner } from '../src/constants.js';

import { createMockApi } from './mocks/homebridge-api.js';
import { MelCloudMock } from './mocks/melcloudata-mock.js';
import {
    sampleDeviceData,
    heatingDeviceData,
    autoDeviceData,
    offDeviceData,
    sampleAccount,
    sampleDeviceConfig,
    sampleAccountInfo,
    sampleMelcloudDevicesList
} from './fixtures/device-data.js';

// Helper to create device instance
function createDevice(deviceConfig = sampleDeviceConfig) {
    const api = createMockApi();
    const melcloud = new MelCloudMock();

    const device = new DeviceAta(
        api,
        sampleAccount,
        deviceConfig,
        '/tmp/temps',
        sampleAccountInfo,
        '/tmp/account',
        melcloud,
        sampleMelcloudDevicesList
    );

    return { device, api };
}

describe('DeviceAta Integration Tests', () => {
    describe('Constructor initialization', () => {
        test('initializes with correct config values', () => {
            const { device } = createDevice();

            assert.strictEqual(device.deviceId, '12345');
            assert.strictEqual(device.deviceName, 'Living Room AC');
            assert.strictEqual(device.accountType, 'melcloud');
            assert.strictEqual(device.heatDryFanMode, 1);
            assert.strictEqual(device.coolDryFanMode, 1);
            assert.strictEqual(device.autoDryFanMode, 1);
        });

        test('is an EventEmitter', () => {
            const { device } = createDevice();

            assert.ok(typeof device.on === 'function');
            assert.ok(typeof device.emit === 'function');
        });

        test('has start method', () => {
            const { device } = createDevice();

            assert.ok(typeof device.start === 'function');
        });
    });

    describe('State parsing - HeaterCooler', () => {
        let device;

        beforeEach(() => {
            device = createDevice(sampleDeviceConfig).device;
        });

        test('COOL mode produces correct state', () => {
            const state = device.stateParser.parse(sampleDeviceData);

            assert.strictEqual(state.power, true);
            assert.strictEqual(state.operationMode, 3); // COOL
            assert.strictEqual(state.currentOperationMode, 3); // COOLING (room > set)
            assert.strictEqual(state.targetOperationMode, 2); // COOL target
            assert.strictEqual(state.roomCurrentTemp, 26.5);
            assert.strictEqual(state.acSetpoint, 24);
            assert.strictEqual(state.setFanSpeed, 3);
        });

        test('HEAT mode produces correct state', () => {
            const state = device.stateParser.parse(heatingDeviceData);

            assert.strictEqual(state.currentOperationMode, 2); // HEATING (room < set)
            assert.strictEqual(state.targetOperationMode, 1); // HEAT target
        });

        test('AUTO mode produces correct state', () => {
            const state = device.stateParser.parse(autoDeviceData);

            assert.strictEqual(state.currentOperationMode, 2); // HEATING (room < set)
            assert.strictEqual(state.targetOperationMode, 0); // AUTO target
        });

        test('OFF state produces correct state', () => {
            const state = device.stateParser.parse(offDeviceData);

            assert.strictEqual(state.power, false);
            assert.strictEqual(state.currentOperationMode, 0); // INACTIVE
        });
    });

    describe('Mode control', () => {
        test('maps HomeKit Cool to MELCloud Cool when legacy mode config is omitted', async () => {
            const { heatDryFanMode, coolDryFanMode, autoDryFanMode, ...deviceConfig } = sampleDeviceConfig;
            const { device } = createDevice(deviceConfig);
            const sentCommands = [];

            device.deviceData = structuredClone(sampleDeviceData);
            device.accessoryState = device.stateParser.parse(device.deviceData);
            device.melCloudAta = {
                send: async (accountType, displayType, deviceData, flag) => {
                    sentCommands.push({ accountType, displayType, deviceData, flag });
                }
            };

            await device.prepareAccessory();
            const targetState = device.services.main.getCharacteristic(device.Characteristic.TargetHeaterCoolerState);

            await targetState._setHandler(device.Characteristic.TargetHeaterCoolerState.COOL);

            assert.strictEqual(device.deviceData.Device.OperationMode, 3);
            assert.strictEqual(sentCommands.at(-1).flag, AirConditioner.EffectiveFlags.OperationMode);
        });
    });

    describe('Capabilities parsing', () => {
        test('parses device capabilities correctly', () => {
            const { device } = createDevice();
            const state = device.stateParser.parse(sampleDeviceData);

            assert.strictEqual(state.supportsAuto, true);
            assert.strictEqual(state.supportsHeat, true);
            assert.strictEqual(state.supportsCool, true);
            assert.strictEqual(state.supportsFanSpeed, true);
            assert.strictEqual(state.supportsSwingFunction, true);
            assert.strictEqual(state.numberOfFanSpeeds, 5);
        });

        test('parses temperature limits correctly', () => {
            const { device } = createDevice();
            const state = device.stateParser.parse(sampleDeviceData);

            assert.strictEqual(state.minTempHeat, 10);
            assert.strictEqual(state.maxTempHeat, 31);
            assert.strictEqual(state.minTempCoolDryAuto, 4);
            assert.strictEqual(state.maxTempCoolDryAuto, 31);
        });
    });
});

console.log('Running DeviceAta integration tests...\n');
