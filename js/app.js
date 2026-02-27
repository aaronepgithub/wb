// FTMS (Fitness Machine Service) UUIDs
const FTMS_SERVICE_UUID = '00001826-0000-1000-8000-00805f9b34fb';
const INDOOR_BIKE_DATA_CHAR_UUID = '00002ad2-0000-1000-8000-00805f9b34fb';
const INDOOR_BIKE_POWER_POINT_CHAR_UUID = '00002ad9-0000-1000-8000-00805f9b34fb';
const FTMS_FEATURE_CHAR_UUID = '00002acc-0000-1000-8000-00805f9b34fb';
const MACHINE_STATUS_CHAR_UUID = '00002ada-0000-1000-8000-00805f9b34fb';
const TRAINING_STATUS_CHAR_UUID = '00002ad3-0000-1000-8000-00805f9b34fb';

let device = null;
let service = null;
let indoorBikeDataCharacteristic = null;
let powerPointCharacteristic = null;
let machineStatusCharacteristic = null;
let trainingStatusCharacteristic = null;

let rideInterval = null;
let rideData = {
  startTime: null,
  totalDistanceMiles: 0,
  powerValues: [],
  cadenceValues: [],
  speedValues: [],
  lastSpeedMph: 0,
  lastCadenceRpm: 0,
  lastPowerWatts: 0,
  targetPowerWatts: 50,
  isRiding: false
};

let isPaused = false;
let pauseStart = null;
let pausedTotal = 0;

let isSettingPower = false;
let nextTargetPower = null;
let commandQueue = [];
let isProcessingQueue = false;
let controlPointPromiseResolver = null;

async function connectToTrainer() {
  try {
    document.getElementById('connection-status').textContent = 'Scanning...';

    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE_UUID] }],
      optionalServices: [FTMS_SERVICE_UUID, FTMS_FEATURE_CHAR_UUID, MACHINE_STATUS_CHAR_UUID, TRAINING_STATUS_CHAR_UUID]
    });

    document.getElementById('connection-status').textContent = 'Connecting...';

    device.addEventListener('gattserverdisconnected', onDisconnected);

    await device.gatt.connect();
    service = await device.gatt.getPrimaryService(FTMS_SERVICE_UUID);

    // Get characteristics
    indoorBikeDataCharacteristic = await service.getCharacteristic(INDOOR_BIKE_DATA_CHAR_UUID);
    powerPointCharacteristic = await service.getCharacteristic(INDOOR_BIKE_POWER_POINT_CHAR_UUID);

    // Some trainers might not support these status characteristics
    try {
      machineStatusCharacteristic = await service.getCharacteristic(MACHINE_STATUS_CHAR_UUID);
      trainingStatusCharacteristic = await service.getCharacteristic(TRAINING_STATUS_CHAR_UUID);
    } catch (e) {
      console.log('Optional status characteristics not found');
    }

    // Start notifications for indoor bike data
    await indoorBikeDataCharacteristic.startNotifications();
    indoorBikeDataCharacteristic.addEventListener('characteristicvaluechanged', handleIndoorBikeData);

    // FTMS: Must enable indications on the Control Point before writing to it
    await powerPointCharacteristic.startNotifications();
    powerPointCharacteristic.addEventListener('characteristicvaluechanged', handleControlPointResponse);

    updateConnectionStatus(true);
    document.getElementById('connect-btn').disabled = true;
    document.getElementById('disconnect-btn').disabled = false;

    // FTMS initialization sequence
    console.log('Initializing trainer...');

    // 1. Request Control
    await sendControlCommand(new Uint8Array([0x00]), 'Request Control');

    // 2. Reset (resets resistance/slope settings)
    await sendControlCommand(new Uint8Array([0x01]), 'Reset');

    // 3. Start/Resume
    await sendControlCommand(new Uint8Array([0x07]), 'Start/Resume');

    // 4. Set Initial Power
    console.log('Applying initial target power...');
    await setTargetPower();

    // Read Features and Status (Useful for debugging)
    await readFeatures();

    try {
      const machineStatusValue = await machineStatusCharacteristic.readValue();
      console.log('Machine Status:', machineStatusValue);
    } catch (e) {
      console.log('Could not read machine status');
    }

  } catch (error) {
    console.error('Connection failed:', error);
    document.getElementById('connection-status').textContent = 'Connection failed';
  }
}

function onDisconnected() {
  updateConnectionStatus(false);
  if (rideData.isRiding) {
    endRide();
  }
}

function updateConnectionStatus(connected) {
  const statusEl = document.getElementById('connection-status');
  if (connected) {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status-connected';
  } else {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status-disconnected';
    document.getElementById('connect-btn').disabled = false;
    document.getElementById('disconnect-btn').disabled = true;
  }
}

function disconnectFromTrainer() {
  if (device && device.gatt.connected) {
    device.gatt.disconnect();
  }
}

function handleIndoorBikeData(event) {
  const value = event.target.value;
  const data = parseIndoorBikeData(value);

  if (data) {
    // convert km/h to mph
    const speedMph = data.speedKmh / 1.60934;
    rideData.lastSpeedMph = speedMph;
    rideData.lastCadenceRpm = data.cadenceRpm;
    rideData.lastPowerWatts = data.powerWatts;

    // Accumulate data for averages
    if (rideData.isRiding && !isPaused) {
      const elapsedSeconds = (Date.now() - rideData.startTime) / 1000;
      rideData.powerValues.push(data.powerWatts);
      rideData.cadenceValues.push(data.cadenceRpm);
      rideData.speedValues.push(speedMph);
      // accumulate miles per second
      rideData.totalDistanceMiles = (rideData.totalDistanceMiles + (speedMph / 3600));

      updateLiveMetrics();
    }
  }
}

function parseIndoorBikeData(dataView) {
  try {
    let offset = 0;
    const flags = dataView.getUint16(offset, true);
    offset += 2;

    // Instantaneous Speed is mandatory (uint16, factor 0.01, unit km/h)
    const speedKmh = dataView.getUint16(offset, true) * 0.01;
    offset += 2;

    let cadenceRpm = 0;
    let powerWatts = 0;

    // Bit 1: Average Speed present (uint16, factor 0.01)
    if (flags & (1 << 1)) offset += 2;

    // Bit 2: Instantaneous Cadence present (uint16, factor 0.5, unit rpm)
    if (flags & (1 << 2)) {
      cadenceRpm = dataView.getUint16(offset, true) * 0.5;
      offset += 2;
    }

    // Bit 3: Average Cadence present (uint16, factor 0.5)
    if (flags & (1 << 3)) offset += 2;

    // Bit 4: Total Distance present (uint24, unit m)
    if (flags & (1 << 4)) offset += 3;

    // Bit 5: Resistance Level present (int16)
    if (flags & (1 << 5)) offset += 2;

    // Bit 6: Instantaneous Power present (int16, unit W)
    if (flags & (1 << 6)) {
      powerWatts = dataView.getInt16(offset, true);
      offset += 2;
    }

    // Only log if we have non-zero data to keep console clean
    if (speedKmh > 0 || cadenceRpm > 0 || powerWatts > 0) {
      console.log(`Parsed Bike Data: Speed=${speedKmh.toFixed(1)}km/h, Cadence=${cadenceRpm}rpm, Power=${powerWatts}W`);
    }

    return { speedKmh, cadenceRpm, powerWatts };
  } catch (e) {
    console.error('Error parsing bike data:', e);
    return null;
  }
}

function handleControlPointResponse(event) {
  const value = event.target.value;
  const opCode = value.getUint8(0);
  const requestOpCode = value.getUint8(1);
  const resultValue = value.getUint8(2);

  // Response OpCode is always 0x80
  if (opCode === 0x80) {
    console.log(`Control Point Response: Request OpCode ${requestOpCode}, Result ${resultValue}`);

    // Resolve the promise if we were waiting for a response
    if (controlPointPromiseResolver) {
      controlPointPromiseResolver({ requestOpCode, resultValue });
      controlPointPromiseResolver = null;
    }

    if (resultValue === 0x01) {
      console.log('Command successful');
    } else {
      console.warn(`Command failed with error code: ${resultValue}`);
    }
  }
}

async function sendControlCommand(data, label = 'Command') {
  if (!powerPointCharacteristic) return;

  console.log(`Sending ${label}...`);

  // Create a promise that waits for the characteristicvaluechanged event (Indication)
  const responsePromise = new Promise((resolve) => {
    controlPointPromiseResolver = resolve;
    // Timeout as fallback
    setTimeout(() => resolve({ timeout: true }), 3000);
  });

  try {
    await powerPointCharacteristic.writeValueWithResponse(data);
    const response = await responsePromise;
    if (response.timeout) {
      console.warn(`${label} timed out waiting for indication`);
    }
  } catch (e) {
    console.error(`${label} failed:`, e);
  }

  // Delay for trainer stability
  await new Promise(r => setTimeout(r, 500));
}

async function readFeatures() {
  try {
    const char = await service.getCharacteristic(FTMS_FEATURE_CHAR_UUID);
    const value = await char.readValue();
    const machineFeatures = value.getUint32(0, true);
    const targetFeatures = value.getUint32(4, true);

    console.log(`Trainer Features: Machine=0x${machineFeatures.toString(16)}, Target=0x${targetFeatures.toString(16)}`);
    console.log(`- Power Control Support: ${Boolean(targetFeatures & 0x02)}`);
    console.log(`- Resistance Level Support: ${Boolean(targetFeatures & 0x01)}`);
    console.log(`- Simulation Support: ${Boolean(targetFeatures & 0x04)}`);
  } catch (e) {
    console.log('Could not read features characteristic');
  }
}

async function setTargetPower() {
  const target = parseInt(document.getElementById('target-power').value);
  if (target < 0) return;

  rideData.targetPowerWatts = target;

  if (!powerPointCharacteristic) return;

  if (isSettingPower) {
    nextTargetPower = target;
    return;
  }

  isSettingPower = true;
  try {
    // FTMS Control Point: OpCode 0x05 (Set Target Power) + 2 bytes signed integer (1 watt units)
    // NOTE: Many trainers defaults to high resistance if sent raw 0.1W values 
    // but the FTMS spec confirms OpCode 0x05 is in 1W increments.
    const powerValue = target; // Unit: 1W
    const data = new DataView(new ArrayBuffer(3));
    data.setUint8(0, 0x05); // OpCode: Set Target Power
    data.setInt16(1, powerValue, true);
    await sendControlCommand(data, `Set Power ${target}W`);
  } catch (e) {
    console.error('Failed to set target power:', e);
  } finally {
    isSettingPower = false;
    if (nextTargetPower !== null) {
      const val = nextTargetPower;
      nextTargetPower = null;
      setTargetPower();
    }
  }
}

function startRide() {
  rideData = {
    startTime: Date.now(),
    totalDistanceMiles: 0,
    powerValues: [],
    cadenceValues: [],
    speedValues: [],
    lastSpeedMph: 0,
    lastCadenceRpm: 0,
    lastPowerWatts: 0,
    targetPowerWatts: parseInt(document.getElementById('target-power').value),
    isRiding: true
  };

  // Set initial target power
  setTargetPower();

  isPaused = false;
  pausedTotal = 0;
  pauseStart = null;

  rideInterval = setInterval(updateLiveMetrics, 1000);
  document.getElementById('start-ride-btn').disabled = true;
  document.getElementById('end-ride-btn').disabled = false;
  document.getElementById('pause-ride-btn').disabled = false;
}

function endRide() {
  clearInterval(rideInterval);
  rideData.isRiding = false;
  isPaused = false;
  showRideSummary();
  document.getElementById('end-ride-btn').disabled = true;
  document.getElementById('pause-ride-btn').disabled = true;
  document.getElementById('pause-ride-btn').textContent = 'Pause';
  document.getElementById('start-ride-btn').disabled = false;
}

function updateLiveMetrics() {
  document.getElementById('power').textContent = rideData.lastPowerWatts.toFixed(0);
  document.getElementById('cadence').textContent = rideData.lastCadenceRpm.toFixed(0);
  document.getElementById('speed').textContent = rideData.lastSpeedMph.toFixed(1);
  document.getElementById('distance').textContent = rideData.totalDistanceMiles.toFixed(2);
  const elapsedMs = Date.now() - rideData.startTime - pausedTotal;
  document.getElementById('time').textContent = formatTime(elapsedMs);

  // Update average displays
  if (rideData.powerValues.length > 0) {
    const avgPower = rideData.powerValues.reduce((a, b) => a + b, 0) / rideData.powerValues.length;
    document.getElementById('avg-power').textContent = avgPower.toFixed(0);
  }
  if (rideData.cadenceValues.length > 0) {
    const avgCadence = rideData.cadenceValues.reduce((a, b) => a + b, 0) / rideData.cadenceValues.length;
    document.getElementById('avg-cadence').textContent = avgCadence.toFixed(0);
  }
  if (rideData.speedValues.length > 0) {
    const avgSpeed = rideData.speedValues.reduce((a, b) => a + b, 0) / rideData.speedValues.length;
    document.getElementById('avg-speed').textContent = avgSpeed.toFixed(1);
  }
}

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secondsLeft = seconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${secondsLeft.toString().padStart(2, '0')}`;
}

function showRideSummary() {
  const duration = Date.now() - rideData.startTime;

  document.getElementById('ride-summary').style.display = 'block';

  // account for paused time
  const totalElapsed = Date.now() - rideData.startTime - pausedTotal;
  document.getElementById('summary-time').textContent = formatTime(totalElapsed);
  document.getElementById('summary-distance').textContent = rideData.totalDistanceMiles.toFixed(2) + ' miles';

  const avgPower = rideData.powerValues.length > 0
    ? rideData.powerValues.reduce((a, b) => a + b, 0) / rideData.powerValues.length
    : 0;
  const maxPower = rideData.powerValues.length > 0
    ? Math.max(...rideData.powerValues)
    : 0;

  const avgCadence = rideData.cadenceValues.length > 0
    ? rideData.cadenceValues.reduce((a, b) => a + b, 0) / rideData.cadenceValues.length
    : 0;
  const maxCadence = rideData.cadenceValues.length > 0
    ? Math.max(...rideData.cadenceValues)
    : 0;

  const avgSpeed = rideData.speedValues.length > 0
    ? rideData.speedValues.reduce((a, b) => a + b, 0) / rideData.speedValues.length
    : 0;
  const maxSpeed = rideData.speedValues.length > 0
    ? Math.max(...rideData.speedValues)
    : 0;

  document.getElementById('summary-avg-power').textContent = avgPower.toFixed(0) + ' watts';
  document.getElementById('summary-avg-cadence').textContent = avgCadence.toFixed(0) + ' rpm';
  document.getElementById('summary-avg-speed').textContent = avgSpeed.toFixed(1) + ' mph';
  document.getElementById('summary-max-power').textContent = maxPower.toFixed(0) + ' watts';
  document.getElementById('summary-max-cadence').textContent = maxCadence.toFixed(0) + ' rpm';
  document.getElementById('summary-max-speed').textContent = maxSpeed.toFixed(1) + ' mph';
}

// Event listeners
document.getElementById('connect-btn').addEventListener('click', connectToTrainer);
document.getElementById('disconnect-btn').addEventListener('click', disconnectFromTrainer);
document.getElementById('start-ride-btn').addEventListener('click', startRide);
document.getElementById('end-ride-btn').addEventListener('click', endRide);
document.getElementById('new-ride-btn').addEventListener('click', () => {
  document.getElementById('ride-summary').style.display = 'none';
  document.getElementById('start-ride-btn').disabled = false;
});

// ERG +/- buttons adjust target by 5 watts per click
document.getElementById('erg-increase').addEventListener('click', () => {
  const inp = document.getElementById('target-power');
  const val = parseInt(inp.value) || 0;
  inp.value = val + 5;
  setTargetPower();
});
document.getElementById('erg-decrease').addEventListener('click', () => {
  const inp = document.getElementById('target-power');
  const val = parseInt(inp.value) || 0;
  inp.value = Math.max(0, val - 5);
  setTargetPower();
});

// Pause/Resume handling
document.getElementById('pause-ride-btn').addEventListener('click', () => {
  const btn = document.getElementById('pause-ride-btn');
  if (!isPaused) {
    // pause
    isPaused = true;
    pauseStart = Date.now();
    clearInterval(rideInterval);
    btn.textContent = 'Resume';
  } else {
    // resume
    isPaused = false;
    pausedTotal += Date.now() - pauseStart;
    pauseStart = null;
    rideInterval = setInterval(updateLiveMetrics, 1000);
    btn.textContent = 'Pause';
  }
});
