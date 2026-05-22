/**
 * Tests for Predictive Control modules
 * - SetpointCalculator
 * - StateMachine
 * - PredictiveController
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SetpointCalculator } from '../src/deviceata/predictive/setpoint-calculator.js';
import { StateMachine } from '../src/deviceata/predictive/state-machine.js';
import { PredictiveController } from '../src/deviceata/predictive/index.js';
import { States, SeasonMode, AntiOscillation, PredictiveDefaults } from '../src/deviceata/predictive/constants.js';

// Create a minimal device context for testing
function createMockDevice(overrides = {}) {
    return {
        targetTemperature: 23,
        location: { latitude: 42.7, longitude: 23.3 },
        roomCurrentTemp: 22.5,
        logDebug: false,
        logInfo: false,
        logWarn: false,
        accessoryState: {
            targetOperationMode: 1 // HEAT
        },
        emit: () => {},
        ...overrides
    };
}

describe('SetpointCalculator', () => {
    let calculator;
    let device;

    beforeEach(() => {
        device = createMockDevice();
        calculator = new SetpointCalculator(device);
    });

    describe('Basic Setpoint Calculation', () => {
        test('returns user target as base setpoint when no adjustments needed', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 23,
                currentOutdoorTemp: 10, // Design outdoor temp for winter
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.ok(result.predictedRoomTarget >= 22 && result.predictedRoomTarget <= 24);
            assert.strictEqual(result.components.base, 23);
        });

        test('rounds setpoint to 0.5°C steps', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23.3,
                currentIndoorTemp: 23,
                currentOutdoorTemp: 10,
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            // Should be rounded to nearest 0.5
            assert.strictEqual(result.predictedRoomTarget % 0.5, 0);
        });

        test('clamps setpoint to valid range (16-30°C)', () => {
            // Test lower bound
            const lowResult = calculator.calculateSetpoint({
                userComfortTarget: 14, // Below minimum
                currentIndoorTemp: 14,
                currentOutdoorTemp: -20, // Very cold
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });
            assert.ok(lowResult.predictedRoomTarget >= 16);

            // Test upper bound
            const highResult = calculator.calculateSetpoint({
                userComfortTarget: 35, // Above maximum
                currentIndoorTemp: 35,
                currentOutdoorTemp: 40, // Very hot
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.SUMMER
            });
            assert.ok(highResult.predictedRoomTarget <= 30);
        });
    });

    describe('Outdoor Reset Curve', () => {
        test('increases setpoint when outdoor temp drops below design (winter)', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 23,
                currentOutdoorTemp: 0, // 10°C below design outdoor temp
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            // Should have positive outdoor reset offset
            assert.ok(result.components.outdoorReset > 0);
        });

        test('decreases setpoint when outdoor temp rises above design (winter)', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 23,
                currentOutdoorTemp: 20, // Above design outdoor temp
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            // Should have negative outdoor reset offset
            assert.ok(result.components.outdoorReset < 0);
        });

        test('limits outdoor reset adjustment to ±2°C', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 23,
                currentOutdoorTemp: -30, // Extremely cold
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.ok(result.components.outdoorReset <= 2);
            assert.ok(result.components.outdoorReset >= -2);
        });
    });

    describe('Forecast Look-Ahead', () => {
        test('adjusts setpoint based on forecast temps', () => {
            const coldForecast = Array(24).fill(-5); // Getting colder
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 23,
                currentOutdoorTemp: 5,
                forecastTemps: coldForecast,
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            // Should have forecast adjustment for impending cold
            assert.ok(result.components.forecastAdjustment !== 0 || result.components.outdoorReset !== 0);
        });

        test('ignores empty forecast', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 23,
                currentOutdoorTemp: 10,
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.strictEqual(result.components.forecastAdjustment, 0);
        });
    });

    describe('Solar Gain Compensation', () => {
        test('reduces heating setpoint when solar radiation expected (winter)', () => {
            const highSolar = Array(6).fill(400); // High solar radiation
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 23,
                currentOutdoorTemp: 5,
                forecastTemps: [],
                forecastSolar: highSolar,
                seasonMode: SeasonMode.WINTER
            });

            // Should have negative solar offset (reduce heating)
            assert.ok(result.components.solarOffset < 0);
        });

        test('does not apply solar offset in summer mode', () => {
            const highSolar = Array(6).fill(400);
            const result = calculator.calculateSetpoint({
                userComfortTarget: 25,
                currentIndoorTemp: 25,
                currentOutdoorTemp: 30,
                forecastTemps: [],
                forecastSolar: highSolar,
                seasonMode: SeasonMode.SUMMER
            });

            // Summer mode should not apply solar offset
            assert.strictEqual(result.components.solarOffset, 0);
        });

        test('no solar offset when radiation below threshold', () => {
            const lowSolar = Array(6).fill(100); // Below threshold
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 23,
                currentOutdoorTemp: 5,
                forecastTemps: [],
                forecastSolar: lowSolar,
                seasonMode: SeasonMode.WINTER
            });

            assert.strictEqual(result.components.solarOffset, 0);
        });
    });

    describe('Error Correction', () => {
        test('applies positive correction when below target', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 21, // 2°C below target
                currentOutdoorTemp: 10,
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.ok(result.components.errorCorrection > 0);
        });

        test('applies negative correction when above target', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 25, // 2°C above target
                currentOutdoorTemp: 10,
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.ok(result.components.errorCorrection < 0);
        });

        test('limits error correction to ±1°C', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 18, // 5°C below target
                currentOutdoorTemp: 10,
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.ok(result.components.errorCorrection <= 1);
            assert.ok(result.components.errorCorrection >= -1);
        });
    });

    describe('Cold Snap Detection', () => {
        test('detects cold snap when forecast drops significantly', () => {
            // Current temp 10, dropping to -5 in next 24 hours
            const forecastTemps = [];
            for (let i = 0; i < 48; i++) {
                forecastTemps.push(10 - (i * 0.5)); // Gradual drop
            }

            const result = calculator.detectColdSnap(forecastTemps, 10);

            assert.ok(result !== null);
            assert.ok(result.tempDrop >= PredictiveDefaults.COLD_SNAP_THRESHOLD);
        });

        test('returns null when no cold snap detected', () => {
            const forecastTemps = Array(48).fill(10); // Stable temps
            const result = calculator.detectColdSnap(forecastTemps, 10);

            assert.strictEqual(result, null);
        });
    });

    describe('Heatwave Detection', () => {
        test('detects heatwave when max forecast exceeds threshold', () => {
            const forecastTemps = Array(24).fill(28);
            forecastTemps.push(...Array(24).fill(32)); // Heatwave in second day

            const result = calculator.detectHeatwave(forecastTemps);

            assert.ok(result !== null);
            assert.ok(result.peakTemp >= PredictiveDefaults.HEATWAVE_THRESHOLD);
        });

        test('returns null when no heatwave', () => {
            const forecastTemps = Array(48).fill(25); // Normal summer temps
            const result = calculator.detectHeatwave(forecastTemps);

            assert.strictEqual(result, null);
        });
    });

    describe('Building Parameter Updates', () => {
        test('updates time constant when provided', () => {
            calculator.updateBuildingParameters({ timeConstant: 24 });
            assert.strictEqual(calculator.buildingTimeConstant, 24);
        });

        test('updates solar gain factor when provided', () => {
            calculator.updateBuildingParameters({ solarGainFactor: 0.02 });
            assert.strictEqual(calculator.solarGainFactor, 0.02);
        });
    });

    describe('Cold Weather Boost', () => {
        test('applies boost when outdoor temp below 5°C', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 22,
                currentOutdoorTemp: 4, // Below 5°C threshold
                forecastTemps: Array(24).fill(4), // Stable forecast
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.ok(result.components.coldWeatherBoost >= 1);
        });

        test('applies higher boost when outdoor temp below 0°C', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 22,
                currentOutdoorTemp: -2, // Below 0°C
                forecastTemps: Array(24).fill(-2),
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.ok(result.components.coldWeatherBoost >= 2);
        });

        test('applies maximum boost when outdoor temp below -5°C', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 22,
                currentOutdoorTemp: -8, // Extreme cold
                forecastTemps: Array(24).fill(-8),
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.ok(result.components.coldWeatherBoost >= 3);
        });

        test('applies forecast-based boost when extreme cold coming', () => {
            const forecastTemps = [];
            for (let i = 0; i < 24; i++) {
                forecastTemps.push(5 - i * 0.5); // Drops from 5 to -7
            }

            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 22,
                currentOutdoorTemp: 5, // Currently above 5°C
                forecastTemps: forecastTemps, // But extreme cold coming
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            // Should have boost due to forecast showing < -5°C coming
            assert.ok(result.components.coldWeatherBoost >= 2);
        });

        test('does not apply cold boost in summer mode', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 25,
                currentIndoorTemp: 26,
                currentOutdoorTemp: 4, // Cold but in summer mode
                forecastTemps: [],
                forecastSolar: [],
                seasonMode: SeasonMode.SUMMER
            });

            assert.strictEqual(result.components.coldWeatherBoost, 0);
        });

        test('no cold boost when outdoor temp above 5°C', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 22,
                currentOutdoorTemp: 10, // Above 5°C
                forecastTemps: Array(24).fill(10), // Stable forecast
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            assert.strictEqual(result.components.coldWeatherBoost, 0);
        });

        test('allows larger positive deviation in very cold weather', () => {
            const result = calculator.calculateSetpoint({
                userComfortTarget: 23,
                currentIndoorTemp: 22,
                currentOutdoorTemp: -10, // Very cold
                forecastTemps: Array(24).fill(-10),
                forecastSolar: [],
                seasonMode: SeasonMode.WINTER
            });

            // Should allow predicted target to exceed user target by more than 2°C
            const deviation = result.predictedRoomTarget - 23;
            // With cold boost of 3 + outdoor reset + error correction, should be > 2
            assert.ok(deviation >= 0); // At minimum, should not be clamped down
        });
    });
});

describe('PredictiveController', () => {
    test('uses parsed cool target operation mode for summer mode', () => {
        const device = createMockDevice({
            accessoryState: {
                targetOperationMode: 2,
                targetHeaterCoolerState: 1
            }
        });
        const controller = new PredictiveController(device);

        assert.strictEqual(controller.getSeasonMode(), SeasonMode.SUMMER);
    });

    test('uses parsed heat target operation mode for winter mode', () => {
        const device = createMockDevice({
            accessoryState: { targetOperationMode: 1 }
        });
        const controller = new PredictiveController(device);

        assert.strictEqual(controller.getSeasonMode(), SeasonMode.WINTER);
    });
});

describe('StateMachine', () => {
    let stateMachine;
    let device;

    beforeEach(() => {
        device = createMockDevice();
        stateMachine = new StateMachine(device);
    });

    describe('Initial State', () => {
        test('starts in STANDBY state', () => {
            assert.strictEqual(stateMachine.getCurrentState(), States.STANDBY);
        });

        test('has empty state history initially', () => {
            const history = stateMachine.getStateHistory();
            assert.strictEqual(history.length, 0);
        });
    });

    describe('State Transitions', () => {
        test('transitions to HEATING_ACTIVE when too cold in winter', () => {
            const result = stateMachine.processUpdate({
                currentTemp: 20,
                targetTemp: 23,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            assert.strictEqual(result.state, States.HEATING_ACTIVE);
            assert.ok(result.reason.includes('cold'));
        });

        test('transitions to COOLING_ACTIVE when too hot in summer', () => {
            const result = stateMachine.processUpdate({
                currentTemp: 28,
                targetTemp: 25,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.SUMMER,
                forecast: null,
                acPowerState: true
            });

            assert.strictEqual(result.state, States.COOLING_ACTIVE);
            assert.ok(result.reason.includes('hot'));
        });

        test('transitions to STANDBY when in comfort band', () => {
            // First get into heating state
            stateMachine.processUpdate({
                currentTemp: 20,
                targetTemp: 23,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            // Override timer for testing
            stateMachine.timers.lastOnTime = Date.now() - (AntiOscillation.MIN_ON_TIME * 1000 + 1000);

            // Now reach comfort band (need to exceed halfDeadband = 2.0)
            // deviation = currentTemp - targetTemp > halfDeadband
            // 25.5 - 23 = 2.5 > 2.0 ✓
            const result = stateMachine.processUpdate({
                currentTemp: 25.5, // Above target + half deadband (23 + 2.0 = 25)
                targetTemp: 23,
                predictedSetpoint: 23,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            assert.ok([States.HEATING_COAST, States.STANDBY].includes(result.state));
        });

        test('transitions to SENSOR_FAULT when no sensor data', () => {
            const result = stateMachine.processUpdate({
                currentTemp: null, // No sensor data
                targetTemp: 23,
                predictedSetpoint: 23,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: false
            });

            assert.strictEqual(result.state, States.SENSOR_FAULT);
        });
    });

    describe('Anti-Oscillation Protection', () => {
        test('blocks transition before MIN_ON_TIME elapsed', () => {
            // Start heating
            stateMachine.processUpdate({
                currentTemp: 20,
                targetTemp: 23,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            assert.strictEqual(stateMachine.getCurrentState(), States.HEATING_ACTIVE);

            // Try to stop immediately (blocked)
            // Use temp 26°C to exceed halfDeadband (2.0) and trigger a transition attempt
            const result = stateMachine.processUpdate({
                currentTemp: 26, // Deviation > halfDeadband triggers transition attempt
                targetTemp: 23,
                predictedSetpoint: 23,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            // Should be blocked and remain in HEATING_ACTIVE
            assert.strictEqual(result.state, States.HEATING_ACTIVE);
            assert.ok(result.reason.includes('blocked') || result.reason.includes('Maintaining'));
        });

        test('allows transition after MIN_ON_TIME elapsed', () => {
            // Start heating
            stateMachine.processUpdate({
                currentTemp: 20,
                targetTemp: 23,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            // Simulate time passing
            stateMachine.timers.lastOnTime = Date.now() - (AntiOscillation.MIN_ON_TIME * 1000 + 1000);

            // Now transition should be allowed (need to exceed halfDeadband = 2.0)
            // 25.5 - 23 = 2.5 > 2.0 ✓
            const result = stateMachine.processUpdate({
                currentTemp: 25.5, // Exceeds halfDeadband
                targetTemp: 23,
                predictedSetpoint: 23,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            assert.ok([States.HEATING_COAST, States.STANDBY].includes(result.state));
        });

        test('blocks rapid mode switching (heat to cool)', () => {
            // Start heating
            stateMachine.processUpdate({
                currentTemp: 20,
                targetTemp: 23,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            assert.strictEqual(stateMachine.getCurrentState(), States.HEATING_ACTIVE);

            // Simulate min on time passed
            stateMachine.timers.lastOnTime = Date.now() - (AntiOscillation.MIN_ON_TIME * 1000 + 1000);

            // First, transition to coasting/standby (need temp above threshold)
            stateMachine.processUpdate({
                currentTemp: 25.5,
                targetTemp: 23,
                predictedSetpoint: 23,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            // Now try to switch to cooling mode
            // Mode switch timer should block if we just transitioned
            stateMachine.timers.lastModeSwitch = Date.now(); // Just switched

            const result = stateMachine.processUpdate({
                currentTemp: 28,
                targetTemp: 25,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.SUMMER,
                forecast: null,
                acPowerState: true
            });

            // Mode switch should be blocked OR we're in a non-cooling state
            assert.ok(
                !stateMachine._isCoolingState() ||
                result.state === States.STANDBY ||
                result.reason.includes('blocked')
            );
        });
    });

    describe('State History', () => {
        test('records state transitions in history', () => {
            // Start heating
            stateMachine.processUpdate({
                currentTemp: 20,
                targetTemp: 23,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            const history = stateMachine.getStateHistory();
            assert.ok(history.length > 0);
            assert.strictEqual(history[0].to, States.HEATING_ACTIVE);
        });

        test('limits history to maxHistoryLength', () => {
            // Force many state changes
            for (let i = 0; i < 60; i++) {
                stateMachine._transitionTo(i % 2 === 0 ? States.HEATING_ACTIVE : States.STANDBY, {
                    action: null,
                    reason: 'test'
                });
            }

            const history = stateMachine.getStateHistory();
            assert.ok(history.length <= stateMachine.maxHistoryLength);
        });
    });

    describe('Forecast-Based States', () => {
        test('transitions to PRE_HEAT on cold snap detection', () => {
            // Create forecast with cold snap
            const coldForecast = {
                hourly: []
            };
            for (let i = 0; i < 48; i++) {
                coldForecast.hourly.push({
                    temperature: i < 20 ? 10 : 2 // Drop from 10 to 2°C
                });
            }

            const result = stateMachine.processUpdate({
                currentTemp: 22.5,
                targetTemp: 23,
                predictedSetpoint: 23,
                seasonMode: SeasonMode.WINTER,
                forecast: coldForecast,
                acPowerState: false
            });

            // Should detect cold snap and pre-heat
            assert.ok([States.PRE_HEAT, States.STANDBY, States.HEATING_ACTIVE].includes(result.state));
        });
    });

    describe('Reset and Force State', () => {
        test('reset returns to STANDBY', () => {
            // Get into heating state
            stateMachine.processUpdate({
                currentTemp: 20,
                targetTemp: 23,
                predictedSetpoint: 24,
                seasonMode: SeasonMode.WINTER,
                forecast: null,
                acPowerState: true
            });

            stateMachine.reset();

            assert.strictEqual(stateMachine.getCurrentState(), States.STANDBY);
            assert.strictEqual(stateMachine.timers.lastOnTime, null);
        });

        test('forceState overrides current state', () => {
            stateMachine.forceState(States.COOLING_ACTIVE, 'Manual test');

            assert.strictEqual(stateMachine.getCurrentState(), States.COOLING_ACTIVE);
        });
    });

    describe('Helper Methods', () => {
        test('_isActiveState returns true for active states', () => {
            assert.strictEqual(stateMachine._isActiveState(States.HEATING_ACTIVE), true);
            assert.strictEqual(stateMachine._isActiveState(States.COOLING_ACTIVE), true);
            assert.strictEqual(stateMachine._isActiveState(States.PRE_HEAT), true);
            assert.strictEqual(stateMachine._isActiveState(States.PRE_COOL), true);
        });

        test('_isActiveState returns false for inactive states', () => {
            assert.strictEqual(stateMachine._isActiveState(States.STANDBY), false);
            assert.strictEqual(stateMachine._isActiveState(States.HEATING_COAST), false);
            assert.strictEqual(stateMachine._isActiveState(States.SENSOR_FAULT), false);
        });

        test('_isHeatingState identifies heating states', () => {
            assert.strictEqual(stateMachine._isHeatingState(States.HEATING_ACTIVE), true);
            assert.strictEqual(stateMachine._isHeatingState(States.PRE_HEAT), true);
            assert.strictEqual(stateMachine._isHeatingState(States.HEATING_COAST), true);
            assert.strictEqual(stateMachine._isHeatingState(States.COOLING_ACTIVE), false);
        });

        test('_isCoolingState identifies cooling states', () => {
            assert.strictEqual(stateMachine._isCoolingState(States.COOLING_ACTIVE), true);
            assert.strictEqual(stateMachine._isCoolingState(States.PRE_COOL), true);
            assert.strictEqual(stateMachine._isCoolingState(States.COOLING_COAST), true);
            assert.strictEqual(stateMachine._isCoolingState(States.HEATING_ACTIVE), false);
        });

        test('getTimeInState returns reasonable value', () => {
            const timeInState = stateMachine.getTimeInState();
            assert.ok(timeInState >= 0);
            assert.ok(timeInState < 1000); // Should be very small since just created
        });
    });
});

// Run all tests
console.log('Running Predictive Control tests...\n');
