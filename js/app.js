// FTMS (Fitness Machine Service) UUIDs
const FTMS_SERVICE_UUID = '00001826-0000-1000-8000-00805f9b34fb';
const INDOOR_BIKE_DATA_CHAR_UUID = '00002ad2-0000-1000-8000-00805f9b34fb';
const INDOOR_BIKE_POWER_POINT_CHAR_UUID = '00002ae0-0000-1000-8000-00805f9b34fb';
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
  totalDistance: 0,
  powerValues: [],
  cadenceValues: [],
  speedValues: [],
  lastSpeedKmh: 0,
  lastCadenceRpm: 0,
  lastPowerWatts: 0,
  targetPowerWatts: 200,
  isRiding: false
};

async function connectToTrainer() {
  try {
    document.getElementById('connection-status').textContent = 'Scanning...';

    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE_UUID] }],
      optionalServices: [FTMS_SERVICE_UUID, INDOOR_BIKE_DATA_CHAR_UUID, INDOOR_BIKE_POWER_POINT_CHAR_UUID, FTMS_FEATURE_CHAR_UUID, MACHINE_STATUS_CHAR_UUID, TRAINING_STATUS_CHAR_UUID]
    });

    document.getElementById('connection-status').textContent = 'Connecting...';

    device.addEventListener('gattserverdisconnected', onDisconnected);

    service = await device.gatt.connect();
    const service = await device.gatt.getPrimaryService(FTMS_SERVICE_UUID);

    // Get characteristics
    indoorBikeDataCharacteristic = await service.getCharacteristic(INDOOR_BIKE_DATA_CHAR_UUID);
    powerPointCharacteristic = await service.getCharacteristic(INDOOR_BIKE_POWER_POINT_CHAR_UUID);
    machineStatusCharacteristic = await service.getCharacteristic(MACHINE_STATUS_CHAR_UUID);
    trainingStatusCharacteristic = await service.getCharacteristic(TRAINING_STATUS_CHAR_UUID);

    // Start notifications for indoor bike data
    await indoorBikeDataCharacteristic.startNotifications();
    indoorBikeDataCharacteristic.addEventListener('characteristicvaluechanged', handleIndoorBikeData);

    // Read machine status
    const machineStatusValue = await machineStatusCharacteristic.readValue();
    console.log('Machine Status:', machineStatusValue);

    updateConnectionStatus(true);
    document.getElementById('connect-btn').disabled = true;
    document.getElementById('disconnect-btn').disabled = false;

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
    rideData.lastSpeedKmh = data.speedKmh;
    rideData.lastCadenceRpm = data.cadenceRpm;
    rideData.lastPowerWatts = data.powerWatts;

    // Accumulate data for averages
    if (rideData.isRiding) {
      const elapsedSeconds = (Date.now() - rideData.startTime) / 1000;
      rideData.powerValues.push(data.powerWatts);
      rideData.cadenceValues.push(data.cadenceRpm);
      rideData.speedValues.push(data.speedKmh);
      rideData.totalDistance = (rideData.totalDistance + (data.speedKmh / 3600)); // km per second

      updateLiveMetrics();
    }
  }
}

function parseIndoorBikeData(dataView) {
  try {
    // Flags (2 bytes)
    const flags = dataView.getUint16(0, true);

    // Instantaneous speed (m/s) - uint16 at offset 2, factor 0.01
    let speedKmh = 0;
    if (flags & 0x0001) {
      speedKmh = dataView.getUint16(2, true) * 0.01 * 3.6;
    }

    // Average speed (m/s) - uint16 at offset 4, factor 0.01
    // (skipping for now)

    // Instantaneous cadence (rpm) - uint8 at offset 6, factor 0.5
    let cadenceRpm = 0;
    if (flags & 0x0002) {
      cadenceRpm = dataView.getUint8(6) * 0.5;
    }

    // Average cadence (rpm) - uint8 at offset 7, factor 0.5
    // (skipping)

    // Total distance (m) - uint24 at offset 8
    // (skipping)

    // Resistance (0.1 units) - int16 at offset 11
    // (skipping)

    // Instantaneous power (W) - int16 at offset 13
    let powerWatts = 0;
    if (flags & 0x0004) {
      powerWatts = dataView.getInt16(13, true);
    }

    // Average power (W) - int16 at offset 15
    // (skipping)

    return { speedKmh, cadenceRpm, powerWatts };
  } catch (e) {
    console.error('Error parsing bike data:', e);
    return null;
  }
}

function setTargetPower() {
  const target = parseInt(document.getElementById('target-power').value);
  if (target < 0) return;

  rideData.targetPowerWatts = target;

  if (powerPointCharacteristic) {
    // FTMS Power Point: 2 bytes signed integer (0.1 watts units)
    const powerValue = target * 10; // Convert to 0.1W units
    const data = new DataView(new ArrayBuffer(2));
    data.setInt16(0, powerValue, true);
    powerPointCharacteristic.writeValue(data);
  }
}

function startRide() {
  rideData = {
    startTime: Date.now(),
    totalDistance: 0,
    powerValues: [],
    cadenceValues: [],
    speedValues: [],
    lastSpeedKmh: 0,
    lastCadenceRpm: 0,
    lastPowerWatts: 0,
    targetPowerWatts: parseInt(document.getElementById('target-power').value),
    isRiding: true
  };

  // Set initial target power
  setTargetPower();

  rideInterval = setInterval(updateLiveMetrics, 1000);
  document.getElementById('start-ride-btn').disabled = true;
  document.getElementById('end-ride-btn').disabled = false;
  document.getElementById('set-erg-btn').disabled = false;
}

function endRide() {
  clearInterval(rideInterval);
  rideData.isRiding = false;
  showRideSummary();
  document.getElementById('end-ride-btn').disabled = true;
}

function updateLiveMetrics() {
  document.getElementById('power').textContent = rideData.lastPowerWatts.toFixed(0);
  document.getElementById('cadence').textContent = rideData.lastCadenceRpm.toFixed(0);
  document.getElementById('speed').textContent = rideData.lastSpeedKmh.toFixed(1);
  document.getElementById('distance').textContent = rideData.totalDistance.toFixed(2);
  document.getElementById('time').textContent = formatTime(Date.now() - rideData.startTime);

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

  document.getElementById('summary-time').textContent = formatTime(duration);
  document.getElementById('summary-distance').textContent = rideData.totalDistance.toFixed(2) + ' km';

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
  document.getElementById('summary-avg-speed').textContent = avgSpeed.toFixed(1) + ' km/h';
  document.getElementById('summary-max-power').textContent = maxPower.toFixed(0) + ' watts';
  document.getElementById('summary-max-cadence').textContent = maxCadence.toFixed(0) + ' rpm';
  document.getElementById('summary-max-speed').textContent = maxSpeed.toFixed(1) + ' km/h';
}

// Event listeners
document.getElementById('connect-btn').addEventListener('click', connectToTrainer);
document.getElementById('disconnect-btn').addEventListener('click', disconnectFromTrainer);
document.getElementById('set-erg-btn').addEventListener('click', setTargetPower);
document.getElementById('start-ride-btn').addEventListener('click', startRide);
document.getElementById('end-ride-btn').addEventListener('click', endRide);
document.getElementById('new-ride-btn').addEventListener('click', () => {
  document.getElementById('ride-summary').style.display = 'none';
  document.getElementById('start-ride-btn').disabled = false;
});
