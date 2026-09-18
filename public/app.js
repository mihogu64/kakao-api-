const GRID_SIZE_DEGREES = 0.00009;
const MAX_GRID_ZOOM_LEVEL = 15;
const MAX_VISIBLE_GRID_CELLS = 12000;
const KOREA_BOUNDS = { minLat: 33.0, maxLat: 38.9, minLng: 124.5, maxLng: 132.0 };

const state = {
  authMode: 'login',
  map: null,
  username: '',
  watchId: null,
  lastRecordedPosition: null,
  paintedGridIds: new Set(),
  gridPolygons: [],
  renderTimer: null,
  playerPosition: null,
  mockMode: false,
  autoMoveTimer: null,
  mockDirection: 'right',
};

const els = {
  authScreen: document.getElementById('authScreen'),
  gameScreen: document.getElementById('gameScreen'),
  authTitle: document.getElementById('authTitle'),
  authDescription: document.getElementById('authDescription'),
  authForm: document.getElementById('authForm'),
  authUsername: document.getElementById('authUsername'),
  authPassword: document.getElementById('authPassword'),
  authSubmit: document.getElementById('authSubmit'),
  authMessage: document.getElementById('authMessage'),
  loginTab: document.getElementById('loginTab'),
  signupTab: document.getElementById('signupTab'),
  locationHistoryList: document.getElementById('locationHistoryList'),
  gridStatus: document.getElementById('gridStatus'),
  testController: document.getElementById('testController'),
  testModeToggle: document.getElementById('testModeToggle'),
  testControllerControls: document.querySelector('.test-controller-controls'),
  autoMoveToggle: document.getElementById('autoMoveToggle'),
};

function setAuthMessage(message, isError = true) {
  els.authMessage.textContent = message;
  els.authMessage.style.color = isError ? '#ffb5c2' : '#9cf4c2';
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isLogin = mode === 'login';
  els.loginTab.classList.toggle('active', isLogin);
  els.signupTab.classList.toggle('active', !isLogin);
  els.authTitle.textContent = isLogin ? '로그인' : '회원가입';
  els.authDescription.textContent = isLogin ? '로그인 후 카카오 지도를 사용할 수 있습니다.' : '닉네임과 비밀번호를 입력해 가입하세요.';
  els.authSubmit.textContent = isLogin ? '로그인' : '회원가입';
  els.authPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
  setAuthMessage('');
}

async function submitAuth(event) {
  event.preventDefault();
  const username = els.authUsername.value.trim();
  const password = els.authPassword.value;
  if (!username || !password) {
    setAuthMessage('닉네임과 비밀번호를 입력하세요.');
    return;
  }

  els.authSubmit.disabled = true;
  setAuthMessage('처리 중...', false);
  try {
    const endpoint = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || '인증에 실패했습니다.');
    }
    localStorage.setItem('territory.token', payload.token);
    state.username = payload.user.username;
    els.authScreen.hidden = true;
    els.gameScreen.hidden = false;
    initMap();
  } catch (error) {
    setAuthMessage(error.message);
  } finally {
    els.authSubmit.disabled = false;
  }
}

function showMapError(message) {
  document.getElementById('map').innerHTML = `<div class="map-error">${message}</div>`;
}

function historyStorageKey() {
  return `territory.locationHistory.${state.username}`;
}

function paintedGridStorageKey() {
  return `territory.paintedGrid.${state.username}`;
}

function loadPaintedGrid() {
  try {
    state.paintedGridIds = new Set(JSON.parse(localStorage.getItem(paintedGridStorageKey()) || '[]'));
  } catch (error) {
    state.paintedGridIds = new Set();
  }
}

function loadLocationHistory() {
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem(historyStorageKey()) || '[]');
  } catch (error) {
    history = [];
  }
  els.locationHistoryList.innerHTML = '';
  history.forEach((location) => {
    const item = document.createElement('li');
    item.textContent = `${location.time} · ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)} (${Math.round(location.accuracy)}m)`;
    els.locationHistoryList.appendChild(item);
  });
}

function distanceInMeters(first, second) {
  const latitude = (second.lat - first.lat) * 111320;
  const longitude = (second.lng - first.lng) * 111320 * Math.cos(first.lat * Math.PI / 180);
  return Math.sqrt(latitude ** 2 + longitude ** 2);
}

function recordLocation(position) {
  const location = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy || 0 };
  if (state.lastRecordedPosition && distanceInMeters(state.lastRecordedPosition, location) < 10) {
    return;
  }
  state.lastRecordedPosition = location;
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem(historyStorageKey()) || '[]');
  } catch (error) {
    history = [];
  }
  history.unshift({ ...location, time: new Date().toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' }) });
  localStorage.setItem(historyStorageKey(), JSON.stringify(history.slice(0, 10)));
  loadLocationHistory();
}

function stopAutoMove() {
  if (state.autoMoveTimer !== null) {
    window.clearInterval(state.autoMoveTimer);
    state.autoMoveTimer = null;
  }
  els.autoMoveToggle.textContent = '자동 이동 시작';
}

function gridIdAt(lat, lng) {
  return `${Math.floor(lng / GRID_SIZE_DEGREES)}:${Math.floor(lat / GRID_SIZE_DEGREES)}`;
}

function setPlayerPosition(map, lat, lng, shouldCenter = true) {
  if (lat < KOREA_BOUNDS.minLat || lat > KOREA_BOUNDS.maxLat || lng < KOREA_BOUNDS.minLng || lng > KOREA_BOUNDS.maxLng) {
    return;
  }

  state.playerPosition = { lat, lng };
  const position = new kakao.maps.LatLng(lat, lng);
  if (!map.userMarker) {
    map.userMarker = new kakao.maps.Marker({ map, position });
  } else {
    map.userMarker.setPosition(position);
  }
  if (shouldCenter) {
    map.setCenter(position);
  }

  state.paintedGridIds.add(gridIdAt(lat, lng));
  localStorage.setItem(paintedGridStorageKey(), JSON.stringify([...state.paintedGridIds]));
  scheduleGridRender(map);
}

function moveMockPlayer(direction) {
  if (!state.mockMode || !state.map || !state.playerPosition) {
    return;
  }

  const deltas = {
    up: { lat: GRID_SIZE_DEGREES, lng: 0 },
    down: { lat: -GRID_SIZE_DEGREES, lng: 0 },
    left: { lat: 0, lng: -GRID_SIZE_DEGREES },
    right: { lat: 0, lng: GRID_SIZE_DEGREES },
  };
  const delta = deltas[direction];
  if (!delta) {
    return;
  }
  setPlayerPosition(
    state.map,
    state.playerPosition.lat + delta.lat,
    state.playerPosition.lng + delta.lng,
  );
}

function enterMockMode() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  state.mockMode = true;
  els.testControllerControls.hidden = false;
  els.testModeToggle.textContent = '테스트 모드 종료';
  const position = state.playerPosition || { lat: 37.5665, lng: 126.9780 };
  setPlayerPosition(state.map, position.lat, position.lng);
}

function exitMockMode() {
  stopAutoMove();
  state.mockMode = false;
  els.testControllerControls.hidden = true;
  els.testModeToggle.textContent = '테스트 모드 켜기';
  requestCurrentLocation(state.map);
}

function toggleAutoMove() {
  if (state.autoMoveTimer !== null) {
    stopAutoMove();
    return;
  }
  state.mockDirection = 'right';
  els.autoMoveToggle.textContent = '자동 이동 정지';
  state.autoMoveTimer = window.setInterval(() => moveMockPlayer(state.mockDirection), 1000);
}

function setGridStatus(message) {
  els.gridStatus.textContent = message;
  els.gridStatus.hidden = !message;
}

function clearGrid(map) {
  state.gridPolygons.forEach((polygon) => polygon.setMap(null));
  state.gridPolygons = [];
}

function renderGrid(map) {
  const bounds = map.getBounds();
  const southWest = bounds.getSouthWest();
  const northEast = bounds.getNorthEast();
  const minLat = Math.max(KOREA_BOUNDS.minLat, southWest.getLat());
  const maxLat = Math.min(KOREA_BOUNDS.maxLat, northEast.getLat());
  const minLng = Math.max(KOREA_BOUNDS.minLng, southWest.getLng());
  const maxLng = Math.min(KOREA_BOUNDS.maxLng, northEast.getLng());

  if (map.getLevel() > MAX_GRID_ZOOM_LEVEL || minLat >= maxLat || minLng >= maxLng) {
    clearGrid(map);
    setGridStatus(minLat >= maxLat || minLng >= maxLng ? '대한민국 범위 밖입니다.' : '격자를 보려면 지도를 더 확대해 주세요.');
    return;
  }

  const firstGridX = Math.floor(minLng / GRID_SIZE_DEGREES);
  const lastGridX = Math.floor(maxLng / GRID_SIZE_DEGREES);
  const firstGridY = Math.floor(minLat / GRID_SIZE_DEGREES);
  const lastGridY = Math.floor(maxLat / GRID_SIZE_DEGREES);
  const cellCount = (lastGridX - firstGridX + 1) * (lastGridY - firstGridY + 1);
  if (cellCount > MAX_VISIBLE_GRID_CELLS) {
    clearGrid(map);
    setGridStatus('격자를 보려면 지도를 더 확대해 주세요.');
    return;
  }

  clearGrid(map);
  setGridStatus('');

  const nextPolygons = [];
  for (let gridX = firstGridX; gridX <= lastGridX; gridX += 1) {
    for (let gridY = firstGridY; gridY <= lastGridY; gridY += 1) {
      const west = gridX * GRID_SIZE_DEGREES;
      const south = gridY * GRID_SIZE_DEGREES;
      const east = (gridX + 1) * GRID_SIZE_DEGREES;
      const north = (gridY + 1) * GRID_SIZE_DEGREES;
      const gridId = `${gridX}:${gridY}`;
      const polygon = new kakao.maps.Polygon({
        map: null,
        path: [
          new kakao.maps.LatLng(south, west),
          new kakao.maps.LatLng(south, east),
          new kakao.maps.LatLng(north, east),
          new kakao.maps.LatLng(north, west),
        ],
        strokeOpacity: 0,
        strokeWeight: 0,
        fillColor: state.paintedGridIds.has(gridId) ? '#000000' : '#64748b',
        fillOpacity: state.paintedGridIds.has(gridId) ? 0.78 : 0.12,
      });
      polygon.gridId = gridId;
      nextPolygons.push(polygon);
    }
  }

  nextPolygons.forEach((polygon) => polygon.setMap(map));
  state.gridPolygons = nextPolygons;
}

function scheduleGridRender(map) {
  window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(() => renderGrid(map), 80);
}

function updateCurrentLocation(map, position) {
  if (state.mockMode) {
    return;
  }
  setPlayerPosition(map, position.coords.latitude, position.coords.longitude);
  recordLocation(position);
}

function requestCurrentLocation(map) {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((position) => updateCurrentLocation(map, position), () => {}, {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 10000,
    });
  }
}

function startLocationWatch(map) {
  if (!navigator.geolocation || state.watchId !== null) {
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(
    (position) => updateCurrentLocation(map, position),
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 },
  );
}

function initMap() {
  if (state.map) {
    return;
  }
  if (!window.kakao?.maps || typeof kakao.maps.load !== 'function') {
    showMapError('카카오 지도 SDK를 불러오지 못했습니다.');
    return;
  }

  kakao.maps.load(() => {
    loadPaintedGrid();
    state.map = new kakao.maps.Map(document.getElementById('map'), {
      center: new kakao.maps.LatLng(37.5665, 126.9780),
      level: 3,
    });
    state.map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
    loadLocationHistory();
    kakao.maps.event.addListener(state.map, 'idle', () => scheduleGridRender(state.map));
    window.addEventListener('resize', () => scheduleGridRender(state.map));
    scheduleGridRender(state.map);
    requestCurrentLocation(state.map);
    startLocationWatch(state.map);
    document.getElementById('locateButton').addEventListener('click', () => {
      if (state.mockMode) {
        exitMockMode();
        return;
      }
      requestCurrentLocation(state.map);
    });
  });
}

els.loginTab.addEventListener('click', () => setAuthMode('login'));
els.signupTab.addEventListener('click', () => setAuthMode('signup'));
els.authForm.addEventListener('submit', submitAuth);
els.testModeToggle.addEventListener('click', () => {
  if (state.mockMode) {
    exitMockMode();
  } else {
    enterMockMode();
  }
});
els.autoMoveToggle.addEventListener('click', toggleAutoMove);
document.querySelectorAll('[data-mock-direction]').forEach((button) => {
  button.addEventListener('click', () => {
    state.mockDirection = button.dataset.mockDirection;
    moveMockPlayer(state.mockDirection);
  });
});
setAuthMode('login');
