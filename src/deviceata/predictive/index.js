import EventEmitter from 'events';
import { WeatherClient } from './weather-client.js';
import { SetpointCalculator } from './setpoint-calculator.js';
import { StateMachine } from './state-machine.js';
import { SeasonMode, HeaterCoolerState, PredictiveDefaults } from './constants.js';

/**
 * Predictive Controller - Main orchestrator for passive house temperature control
 *
 * Coordinates:
 * - Weather forecast fetching and caching
 * - Predictive setpoint calculation
 * - State machine for AC control
 * - Integration with external temperature sensor
 */
class PredictiveController extends EventEmitter {
    constructor(device) {
        super();
        this.device = device;

        // Target temperature from config
        this.targetTemperature = device.targetTemperature || PredictiveDefaults.DEFAULT_TARGET_TEMP;
        this.comfortBand = PredictiveDefaults.COMFORT_BAND;

        // Sub-modules
        this.weatherClient = new WeatherClient(device);
        this.setpointCalculator = new SetpointCalculator(device);
        this.stateMachine = new StateMachine(device);

        // Current state
        this.lastCalculatedSetpoint = null;
        this.lastSeasonMode = null;
        this.userComfortPreference = null; // User's adjustment within comfort band

        // Wire up events
        this._setupEventHandlers();
    }

    /**
     * Initialize the predictive controller
     */
    async init() {
        this.device.emit('debug', 'PredictiveController: Initializing...');

        // Initialize weather client
        await this.weatherClient.init();

        // Initialize with target temperature
        this.userComfortPreference = this.targetTemperature;

        this.device.emit('success', `PredictiveController: Initialized (target: ${this.targetTemperature}°C ±${this.comfortBand}°C)`);
        return true;
    }

    /**
     * Stop the controller
     */
    stop() {
        this.weatherClient.stop();
    }

    /**
     * Setup event handlers for sub-modules
     */
    _setupEventHandlers() {
        // Weather client events
        this.weatherClient.on('forecast', (forecast) => {
            this.device.emit('debug', `PredictiveController: New forecast received (${forecast.hourly.length} hours)`);
        });

        this.weatherClient.on('unavailable', (error) => {
            this.device.emit('warn', `PredictiveController: Weather unavailable - ${error.message}`);
        });

        this.weatherClient.on('debug', (msg) => this.device.emit('debug', msg));
        this.weatherClient.on('warn', (msg) => this.device.emit('warn', msg));
        this.weatherClient.on('success', (msg) => this.device.emit('success', msg));

        // State machine events
        this.stateMachine.on('stateChange', (change) => {
            this.device.emit('info', `State: ${change.oldState} → ${change.newState} (${change.reason})`);
        });
    }

    /**
     * Get the season mode based on HomeKit HeaterCooler state
     */
    getSeasonMode() {
        const targetState = this.device.accessoryState?.targetOperationMode;

        if (targetState === HeaterCoolerState.HEAT) {
            return SeasonMode.WINTER;
        }
        if (targetState === HeaterCoolerState.COOL) {
            return SeasonMode.SUMMER;
        }

        // Auto mode: decide based on forecast
        const avgForecast = this.weatherClient.getAverageForecastTemp(24);
        if (avgForecast !== null) {
            return avgForecast > this.targetTemperature ? SeasonMode.SUMMER : SeasonMode.WINTER;
        }

        // Fallback to winter
        return SeasonMode.WINTER;
    }

    /**
     * Get the comfort band range for HomeKit
     */
    getComfortRange() {
        return {
            min: this.targetTemperature - this.comfortBand,
            max: this.targetTemperature + this.comfortBand,
            target: this.targetTemperature
        };
    }

    /**
     * Set user's comfort preference (called from HeaterCooler service)
     * This is the temperature the user sets within the comfort band
     */
    setUserComfortPreference(temperature) {
        const range = this.getComfortRange();

        // Clamp to comfort band
        this.userComfortPreference = Math.max(range.min, Math.min(range.max, temperature));

        this.device.emit('debug', `PredictiveController: User comfort preference set to ${this.userComfortPreference}°C`);

        return this.userComfortPreference;
    }

    /**
     * Get user's comfort preference
     */
    getUserComfortPreference() {
        return this.userComfortPreference || this.targetTemperature;
    }

    /**
     * Calculate the predictive setpoint
     * This is the actual temperature to send to the AC
     */
    calculateSetpoint() {
        const currentIndoorTemp = this.device.roomCurrentTemp;
        const currentOutdoorTemp = this.weatherClient.getCurrentOutdoorTemp();
        const forecastTemps = this.weatherClient.getForecastTemperatures(24);
        const forecastSolar = this.weatherClient.getForecastSolarRadiation(24);
        const seasonMode = this.getSeasonMode();
        const userComfortTarget = this.getUserComfortPreference();

        // Calculate predicted room target
        const result = this.setpointCalculator.calculateSetpoint({
            userComfortTarget,
            currentIndoorTemp,
            currentOutdoorTemp,
            forecastTemps,
            forecastSolar,
            seasonMode
        });

        this.lastCalculatedSetpoint = result.predictedRoomTarget;
        this.lastSeasonMode = seasonMode;

        if (this.device.logDebug) {
            this.device.emit('debug', `PredictiveController: Predicted room target ${result.predictedRoomTarget}°C (${result.reason})`);
        }

        return result;
    }

    /**
     * Get the predicted room target for use in HeaterCooler service
     * This combines the predictive calculation with external sensor compensation
     */
    getPredictiveSetpoint(userTarget) {
        // Update user preference
        this.setUserComfortPreference(userTarget);

        // Calculate predicted room target
        const result = this.calculateSetpoint();

        return result.predictedRoomTarget;
    }

    /**
     * Process a device state update
     * Called when MELCloud state changes
     */
    processStateUpdate(deviceData) {
        // Get current temperatures
        const currentTemp = this.device.roomCurrentTemp;
        const userComfortTarget = this.getUserComfortPreference();
        const acPowerState = deviceData?.Device?.Power || false;
        const acSetTemp = deviceData?.Device?.SetTemperature;
        const acRoomTemp = deviceData?.Device?.RoomTemperature;
        const outdoorTemp = this.weatherClient.getCurrentOutdoorTemp();

        // Calculate predicted room target
        const setpointResult = this.calculateSetpoint();
        const seasonMode = this.getSeasonMode();

        // Log prediction summary
        if (this.device.logInfo) {
            this.device.emit('info',
                `Predict: indoor=${currentTemp?.toFixed(1) || '?'}°C, outdoor=${outdoorTemp?.toFixed(1) || '?'}°C, ` +
                `target=${userComfortTarget}°C → room target=${setpointResult.predictedRoomTarget}°C (${setpointResult.reason})`
            );
        }

        // Process through state machine
        const stateResult = this.stateMachine.processUpdate({
            currentTemp,
            targetTemp: userComfortTarget,
            predictedSetpoint: setpointResult.predictedRoomTarget,
            seasonMode,
            forecast: this.weatherClient.getForecast(),
            acPowerState
        });

        // Log action if one will be taken
        if (stateResult.action && this.device.logDebug) {
            this.device.emit('debug',
                `PredictiveController: Action=${stateResult.action.type}, state=${stateResult.state}, reason=${stateResult.reason}`
            );
        }

        // Emit prediction data for logging
        this.emit('prediction', {
            timestamp: new Date(),
            currentTemp,
            userComfortTarget,
            predictedSetpoint: setpointResult.predictedRoomTarget,
            setpointComponents: setpointResult.components,
            state: stateResult.state,
            seasonMode,
            outdoorTemp,
            solarRadiation: this.weatherClient.getCurrentSolarRadiation()
        });

        return stateResult;
    }

    /**
     * Get current status for logging/debugging
     */
    getStatus() {
        return {
            state: this.stateMachine.getCurrentState(),
            seasonMode: this.getSeasonMode(),
            userComfortPreference: this.userComfortPreference,
            lastCalculatedSetpoint: this.lastCalculatedSetpoint,
            weatherAvailable: this.weatherClient.getIsAvailable(),
            currentOutdoorTemp: this.weatherClient.getCurrentOutdoorTemp(),
            comfortRange: this.getComfortRange()
        };
    }

    /**
     * Update building parameters from thermal calibration
     */
    updateBuildingParameters(params) {
        this.setpointCalculator.updateBuildingParameters(params);
        this.device.emit('info', `PredictiveController: Building parameters updated`);
    }
}

export { PredictiveController };
export default PredictiveController;
