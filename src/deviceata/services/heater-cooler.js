import { AirConditioner, TemperatureDisplayUnits } from '../../constants.js';

/**
 * HeaterCooler service for displayType 1
 * Modified for predictive passive house control with comfort band
 */
export class HeaterCoolerService {
    constructor(device) {
        this.device = device;
    }

    /**
     * Get temperature range based on predictive control config
     * Returns comfort band if predictive control is enabled
     */
    _getTemperatureRange(state) {
        const d = this.device;

        // If predictive controller is available, use comfort band
        if (d.predictiveController) {
            const range = d.predictiveController.getComfortRange();
            return {
                minValue: range.min,
                maxValue: range.max,
                minStep: 0.5
            };
        }

        // Fallback to device limits
        return {
            minValue: state.minTempCoolDryAuto,
            maxValue: state.maxTempCoolDryAuto,
            minStep: state.temperatureStep
        };
    }

    _resolveOperationMode(targetState) {
        const d = this.device;
        const currentMode = d.accessoryState.operationMode;
        const supportsDry = d.deviceData.Device.ModelSupportsDry ?? d.deviceData.Device.CanDry ?? false;

        switch (targetState) {
            case 0: return [currentMode, 8, supportsDry ? 2 : 8, 7][d.autoDryFanMode] ?? 8;
            case 1: return [currentMode, 1, supportsDry ? 2 : 1, 7][d.heatDryFanMode] ?? 1;
            case 2: return [currentMode, 3, supportsDry ? 2 : 3, 7][d.coolDryFanMode] ?? 3;
            default: return currentMode;
        }
    }

    create(accessory, serviceName, deviceId) {
        const d = this.device;
        const Service = d.Service;
        const Characteristic = d.Characteristic;
        const state = d.accessoryState;

        if (d.logDebug) d.emit('debug', `Prepare heater/cooler service`);

        const service = new Service.HeaterCooler(serviceName, `HeaterCooler ${deviceId}`);
        service.setPrimaryService(true);

        // Active (power)
        service.getCharacteristic(Characteristic.Active)
            .onGet(async () => d.accessoryState.power)
            .onSet(async (value) => {
                try {
                    d.deviceData.Device.Power = value ? true : false;
                    if (d.logInfo) d.emit('info', `Set power: ${value ? 'On' : 'Off'}`);
                    await d.melCloudAta.send(d.accountType, d.displayType, d.deviceData, AirConditioner.EffectiveFlags.Power);
                } catch (error) {
                    if (d.logWarn) d.emit('warn', `Set power error: ${error}`);
                }
            });

        // Current state
        service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
            .onGet(async () => d.accessoryState.currentOperationMode);

        // Target state
        service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
            .setProps({
                minValue: state.operationModeSetPropsMinValue,
                maxValue: state.operationModeSetPropsMaxValue,
                validValues: state.operationModeSetPropsValidValues
            })
            .onGet(async () => d.accessoryState.targetOperationMode)
            .onSet(async (value) => {
                try {
                    value = this._resolveOperationMode(value);
                    d.deviceData.Device.OperationMode = value;
                    if (d.logInfo) d.emit('info', `Set operation mode: ${AirConditioner.OperationModeMapEnumToString[value]}`);
                    await d.melCloudAta.send(d.accountType, d.displayType, d.deviceData, AirConditioner.EffectiveFlags.OperationMode);
                } catch (error) {
                    if (d.logWarn) d.emit('warn', `Set operation mode error: ${error}`);
                }
            });

        // Current temperature
        service.getCharacteristic(Characteristic.CurrentTemperature)
            .onGet(async () => d.accessoryState.roomCurrentTemp);

        // Fan speed
        if (state.supportsFanSpeed) {
            service.getCharacteristic(Characteristic.RotationSpeed)
                .setProps({
                    minValue: 0,
                    maxValue: state.fanSpeedSetPropsMaxValue,
                    minStep: 1
                })
                .onGet(async () => d.accessoryState.currentFanSpeed)
                .onSet(async (value) => {
                    try {
                        const fanKey = d.accountType === 'melcloud' ? 'FanSpeed' : 'SetFanSpeed';
                        const numSpeeds = d.accessoryState.numberOfFanSpeeds;
                        const autoFan = d.accessoryState.supportsAutomaticFanSpeed;

                        switch (numSpeeds) {
                            case 2: value = autoFan ? [0, 1, 2, 0][value] : [1, 1, 2][value]; break;
                            case 3: value = autoFan ? [0, 1, 2, 3, 0][value] : [1, 1, 2, 3][value]; break;
                            case 4: value = autoFan ? [0, 1, 2, 3, 4, 0][value] : [1, 1, 2, 3, 4][value]; break;
                            case 5: value = autoFan ? [0, 1, 2, 3, 4, 5, 0][value] : [1, 1, 2, 3, 4, 5][value]; break;
                        }

                        d.deviceData.Device[fanKey] = value;
                        if (d.logInfo) d.emit('info', `Set fan speed mode: ${AirConditioner.FanSpeedMapEnumToString[value]}`);
                        await d.melCloudAta.send(d.accountType, d.displayType, d.deviceData, AirConditioner.EffectiveFlags.SetFanSpeed);
                    } catch (error) {
                        if (d.logWarn) d.emit('warn', `Set fan speed mode error: ${error}`);
                    }
                });
        }

        // Swing mode
        if (state.supportsSwingFunction) {
            service.getCharacteristic(Characteristic.SwingMode)
                .onGet(async () => d.accessoryState.currentSwingMode)
                .onSet(async (value) => {
                    try {
                        if (d.accessoryState.supportsWideVane) {
                            d.deviceData.Device.VaneHorizontalDirection = value ? 12 : 0;
                        }
                        d.deviceData.Device.VaneVerticalDirection = value ? 7 : 0;
                        if (d.logInfo) d.emit('info', `Set air direction mode: ${AirConditioner.AirDirectionMapEnumToString[value]}`);
                        await d.melCloudAta.send(d.accountType, d.displayType, d.deviceData, AirConditioner.EffectiveFlags.VaneVerticalVaneHorizontal);
                    } catch (error) {
                        if (d.logWarn) d.emit('warn', `Set air direction mode error: ${error}`);
                    }
                });
        }

        // Cooling threshold temperature
        // Uses comfort band range when predictive control is enabled
        const coolingTempRange = this._getTemperatureRange(state);
        service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
            .setProps(coolingTempRange)
            .onGet(async () => {
                // Return user's comfort preference (not actual AC setpoint)
                if (d.predictiveController) {
                    return d.predictiveController.getUserComfortPreference();
                }
                if (d.userTargetTemperature !== null) {
                    return d.userTargetTemperature;
                }
                const s = d.accessoryState;
                return s.operationMode === 8 ? s.defaultCoolingSetTemperature : s.acSetpoint;
            })
            .onSet(async (value) => {
                try {
                    // Store user's comfort preference
                    d.userTargetTemperature = value;

                    // Calculate setpoint through predictive controller if available
                    let setpoint = value;
                    if (d.predictiveController) {
                        setpoint = d.predictiveController.getPredictiveSetpoint(value);
                        if (d.logDebug) d.emit('debug', `Predictive setpoint: ${value}°C → ${setpoint}°C`);
                    }

                    // Apply external sensor compensation
                    const compensatedValue = d.externalSensor.getCompensatedTargetTemperature(setpoint);
                    d.lastCompensatedTarget = compensatedValue;

                    // Send to AC
                    const tempKey = d.accessoryState.operationMode === 8 ? 'DefaultCoolingSetTemperature' : 'SetTemperature';
                    d.deviceData.Device[tempKey] = Math.max(16, compensatedValue);

                    if (d.logInfo) d.emit('info', `Set cooling temperature: ${value}°C (AC setpoint: ${compensatedValue}°C)`);
                    await d.melCloudAta.send(d.accountType, d.displayType, d.deviceData, AirConditioner.EffectiveFlags.SetTemperature);
                } catch (error) {
                    if (d.logWarn) d.emit('warn', `Set cooling threshold temperature error: ${error}`);
                }
            });

        // Heating threshold temperature
        // Uses comfort band range when predictive control is enabled
        if (state.supportsHeat) {
            const heatingTempRange = this._getTemperatureRange(state);
            service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .setProps(heatingTempRange)
                .onGet(async () => {
                    // Return user's comfort preference (not actual AC setpoint)
                    if (d.predictiveController) {
                        return d.predictiveController.getUserComfortPreference();
                    }
                    if (d.userTargetTemperature !== null) {
                        return d.userTargetTemperature;
                    }
                    const s = d.accessoryState;
                    return s.operationMode === 8 ? s.defaultHeatingSetTemperature : s.acSetpoint;
                })
                .onSet(async (value) => {
                    try {
                        // Store user's comfort preference
                        d.userTargetTemperature = value;

                        // Calculate setpoint through predictive controller if available
                        let setpoint = value;
                        if (d.predictiveController) {
                            setpoint = d.predictiveController.getPredictiveSetpoint(value);
                            if (d.logDebug) d.emit('debug', `Predictive setpoint: ${value}°C → ${setpoint}°C`);
                        }

                        // Apply external sensor compensation
                        const compensatedValue = d.externalSensor.getCompensatedTargetTemperature(setpoint);
                        d.lastCompensatedTarget = compensatedValue;

                        // Send to AC
                        const tempKey = d.accessoryState.operationMode === 8 ? 'DefaultHeatingSetTemperature' : 'SetTemperature';
                        d.deviceData.Device[tempKey] = compensatedValue;

                        if (d.logInfo) d.emit('info', `Set heating temperature: ${value}°C (AC setpoint: ${compensatedValue}°C)`);
                        await d.melCloudAta.send(d.accountType, d.displayType, d.deviceData, AirConditioner.EffectiveFlags.SetTemperature);
                    } catch (error) {
                        if (d.logWarn) d.emit('warn', `Set heating threshold temperature error: ${error}`);
                    }
                });
        }

        // Lock physical controls
        service.getCharacteristic(Characteristic.LockPhysicalControls)
            .onGet(async () => d.accessoryState.lockPhysicalControl)
            .onSet(async (value) => {
                if (d.account.type === 'melcloudhome') return;
                try {
                    value = value ? true : false;
                    d.deviceData.Device.ProhibitSetTemperature = value;
                    d.deviceData.Device.ProhibitOperationMode = value;
                    d.deviceData.Device.ProhibitPower = value;
                    if (d.logInfo) d.emit('info', `Set local physical controls: ${value ? 'Lock' : 'Unlock'}`);
                    await d.melCloudAta.send(d.accountType, d.displayType, d.deviceData, AirConditioner.EffectiveFlags.Prohibit);
                } catch (error) {
                    if (d.logWarn) d.emit('warn', `Set lock physical controls error: ${error}`);
                }
            });

        // Temperature display units
        service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(async () => d.accessoryState.useFahrenheit)
            .onSet(async (value) => {
                if (d.account.type === 'melcloudhome') return;
                try {
                    d.accessoryState.useFahrenheit = value ? true : false;
                    d.accountInfo.UseFahrenheit = value ? true : false;
                    if (d.logInfo) d.emit('info', `Set temperature display unit: ${TemperatureDisplayUnits[value]}`);
                    await d.melCloudAta.send(d.accountType, d.displayType, d.deviceData, 'account', d.accountInfo);
                } catch (error) {
                    if (d.logWarn) d.emit('warn', `Set temperature display unit error: ${error}`);
                }
            });

        accessory.addService(service);
        return service;
    }
}
