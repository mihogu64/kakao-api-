const GRID_SIZE_DEGREES = 0.00009;
const MAX_CLAIMED_TILE_ZOOM_LEVEL = 5;
const LOCATION_RECENTER_IDLE_MS = 10000;
const LOCATION_REQUEST_TIMEOUT_MS = 12000;
const GPS_CONFIG = {
  maxAccuracyForClaim: 300,
  maxJumpDistance: 500,
  maxSpeedMps: 70,
  maxDisplayJumpDistance: 1000,
  maxDisplaySpeedMps: 100,
  minRouteSampleMeters: 8,
  headingTurnThreshold: 45,
};
const MAX_VISIBLE_GRID_CELLS = 12000;
const KOREA_BOUNDS = { minLat: 33.0, maxLat: 38.9, minLng: 124.5, maxLng: 132.0 };
const INITIAL_MAP_CENTER = { lat: 35.9, lng: 128.0 };

const state = {
  authMode: 'login',
  selectedTeamId: '',
  map: null,
  userId: '',
  username: '',
  teamColor: null,
  teamId: '',
  watchId: null,
  locationSuccessCount: 0,
  previousLocation: null,
  previousClaimLocation: null,
  processedLocationKeys: new Set(),
  centerOnNextLocation: false,
  hasCenteredOnLocation: false,
  lastMapInteractionAt: 0,
  lastRecordedPosition: null,
  sharedTiles: new Map(),
  playerOverlays: new Map(),
  lastSyncedPosition: null,
  lastServerTileResetAt: null,
  deleteMode: false,
  syncTimer: null,
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
  accountToggle: document.getElementById('accountToggle'),
  accountBody: document.getElementById('accountBody'),
  accountUsername: document.getElementById('accountUsername'),
  accountTeam: document.getElementById('accountTeam'),
  seasonButton: document.getElementById('seasonButton'),
  seasonModal: document.getElementById('seasonModal'),
  seasonCloseButton: document.getElementById('seasonCloseButton'),
  seasonDetails: document.getElementById('seasonDetails'),
  settingsButton: document.getElementById('settingsButton'),
  settingsModal: document.getElementById('settingsModal'),
  settingsCloseButton: document.getElementById('settingsCloseButton'),
  locationTrackingToggle: document.getElementById('locationTrackingToggle'),
  zoomFocusInputs: document.querySelectorAll('input[name="zoomFocus"]'),
  themeInputs: document.querySelectorAll('input[name="theme"]'),
  fullscreenButton: document.getElementById('fullscreenButton'),
  logoutButton: document.getElementById('logoutButton'),
  authForm: document.getElementById('authForm'),
  authUsername: document.getElementById('authUsername'),
  authPassword: document.getElementById('authPassword'),
  authSubmit: document.getElementById('authSubmit'),
  authMessage: document.getElementById('authMessage'),
  teamSelection: document.getElementById('teamSelection'),
  teamOptions: document.getElementById('teamOptions'),
  termsField: document.getElementById('termsField'),
  termsAgreement: document.getElementById('termsAgreement'),
  loginTab: document.getElementById('loginTab'),
  signupTab: document.getElementById('signupTab'),
  locationHistoryList: document.getElementById('locationHistoryList'),
  tileToast: document.getElementById('tileToast'),
  gridStatus: document.getElementById('gridStatus'),
  zoomInButton: document.getElementById('zoomInButton'),
  zoomOutButton: document.getElementById('zoomOutButton'),
  leaderboardList: document.getElementById('leaderboardList'),
  leaderboardUpdated: document.getElementById('leaderboardUpdated'),
  leaderboardToggle: document.getElementById('leaderboardToggle'),
  leaderboardBody: document.getElementById('leaderboardBody'),
  ownTeamCaptureIcon: document.getElementById('ownTeamCaptureIcon'),
  ownTeamCaptureCount: document.getElementById('ownTeamCaptureCount'),
  gpsStatusCard: document.getElementById('gpsStatusCard'),
  gpsDebugStatus: document.getElementById('gpsDebugStatus'),
  gpsDebugPosition: document.getElementById('gpsDebugPosition'),
  gpsDebugUpdated: document.getElementById('gpsDebugUpdated'),
  gpsAccuracyHint: document.getElementById('gpsAccuracyHint'),
  gpsStatusToggle: document.getElementById('gpsStatusToggle'),
  gpsStatusLive: document.getElementById('gpsStatusLive'),
  gpsStatusBody: document.getElementById('gpsStatusBody'),
  paintedTileCount: document.getElementById('paintedTileCount'),
  paintedTileList: document.getElementById('paintedTileList'),
  teamMembersTitle: document.getElementById('teamMembersTitle'),
  teamSummary: document.getElementById('teamSummary'),
  teamMembersToggle: document.getElementById('teamMembersToggle'),
  teamMembersBody: document.getElementById('teamMembersBody'),
  teamMembersList: document.getElementById('teamMembersList'),
};

let tileToastTimer = null;

function showTileToast(message, tone = 'info') {
  window.clearTimeout(tileToastTimer);
  els.tileToast.textContent = message;
  els.tileToast.className = `tile-toast ${tone}`;
  els.tileToast.hidden = false;
  tileToastTimer = window.setTimeout(() => {
    els.tileToast.hidden = true;
  }, 4000);
}

function setAuthMessage(message, isError = true) {
  els.authMessage.textContent = message;
  els.authMessage.style.color = isError ? '#ffb5c2' : '#9cf4c2';
}

function renderAccountInfo() {
  els.accountUsername.textContent = state.username || '사용자';
  els.accountTeam.textContent = state.teamId ? `${state.teamId} 팀` : '팀 정보 없음';
  els.accountTeam.style.color = state.teamColor || '';
}

function toggleAccountPanel() {
  const expanded = els.accountToggle.getAttribute('aria-expanded') === 'true';
  els.accountToggle.setAttribute('aria-expanded', String(!expanded));
  els.accountBody.hidden = expanded;
}

function toggleGpsStatus() {
  const expanded = els.gpsStatusToggle.getAttribute('aria-expanded') === 'true';
  els.gpsStatusToggle.setAttribute('aria-expanded', String(!expanded));
  els.gpsStatusBody.hidden = expanded;
  els.gpsStatusToggle.querySelector('b').textContent = expanded ? '펼치기' : '접기';
}

function openSettings() {
  els.settingsModal.hidden = false;
  els.accountBody.hidden = true;
  els.accountToggle.setAttribute('aria-expanded', 'false');
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

function formatSeasonDate(value) {
  if (!value) {
    return '정보 없음';
  }
  return new Date(value).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

async function openSeasonModal() {
  els.seasonModal.hidden = false;
  els.seasonDetails.textContent = '시즌 정보를 불러오는 중...';
  try {
    const response = await fetch('/api/state', { headers: authHeaders() });
    if (handleUnauthorized(response) || !response.ok) {
      throw new Error('시즌 정보를 불러오지 못했습니다.');
    }
    const payload = await response.json();
    const currentTeam = payload.leaderboard.find((team) => team.id === state.teamId);
    const rank = currentTeam ? payload.leaderboard.indexOf(currentTeam) + 1 : null;
    const status = payload.phase === 'SETTLEMENT' ? '정산 중' : '시즌 진행 중';
    const season = payload.season || {};
    els.seasonDetails.innerHTML = `
      <p class="season-status">${status}</p>
      <dl>
        <dt>시즌</dt><dd>${payload.seasonKey || '정보 없음'}</dd>
        <dt>시작</dt><dd>${formatSeasonDate(season.startedAt)}</dd>
        <dt>내 팀 순위</dt><dd>${rank ? `${rank}위` : '순위 없음'}</dd>
        <dt>내 팀 점령</dt><dd>${currentTeam ? `${currentTeam.tiles}칸` : '0칸'}</dd>
        <dt>팀 점수</dt><dd>${currentTeam ? `${currentTeam.groupPoints}점` : '0점'}</dd>
      </dl>
    `;
  } catch (error) {
    els.seasonDetails.textContent = error.message;
  }
}

function closeSeasonModal() {
  els.seasonModal.hidden = true;
}

function setLocationTracking(enabled) {
  localStorage.setItem('territory.locationTracking', String(enabled));
  if (enabled) {
    startLocationWatch(state.map);
    requestCurrentLocation(state.map);
    updateGpsDebug('현재 위치 요청 중');
  } else {
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    updateGpsDebug('위치 정보 수집 중지');
  }
}

function getTheme() {
  return localStorage.getItem('territory.theme') || 'system';
}

function applyTheme(theme = getTheme()) {
  const validTheme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  document.documentElement.dataset.theme = validTheme;
}

function setTheme(theme) {
  if (!['light', 'dark', 'system'].includes(theme)) {
    return;
  }
  localStorage.setItem('territory.theme', theme);
  applyTheme(theme);
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  els.gameScreen.requestFullscreen?.();
}

function getZoomFocus() {
  return localStorage.getItem('territory.zoomFocus') || 'center';
}

function setZoomFocus(value) {
  localStorage.setItem('territory.zoomFocus', value);
}

function zoomMap(levelDelta) {
  if (!state.map) {
    return;
  }
  if (getZoomFocus() === 'location' && state.playerPosition) {
    state.map.setCenter(new kakao.maps.LatLng(state.playerPosition.lat, state.playerPosition.lng));
  }
  state.map.setLevel(Math.max(1, Math.min(14, state.map.getLevel() + levelDelta)));
}

function logout() {
  localStorage.removeItem('territory.token');
  window.location.reload();
}

function updateGpsDebug(status, position = null) {
  els.gpsDebugStatus.textContent = status;
  els.gpsStatusLive.textContent = status;
  const tone = status.includes('점령 가능') || status.includes('위치 수신 중')
    ? 'ready'
    : status.includes('실패') || status.includes('오류') || status.includes('보류') || status.includes('보호막')
      ? 'warning'
      : 'waiting';
  els.gpsStatusCard.className = `gps-status-card ${tone}`;
  if (position) {
    state.locationSuccessCount += 1;
    const accuracy = Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null;
    els.gpsDebugPosition.textContent = accuracy === null ? '정확도 확인 불가' : `현재 정확도 ${accuracy}m`;
    els.gpsDebugUpdated.textContent = `마지막 갱신 ${new Date().toLocaleTimeString('ko-KR')}`;
    els.gpsAccuracyHint.hidden = accuracy === null || accuracy <= GPS_CONFIG.maxAccuracyForClaim;
  }
}

function describeLocationError(error) {
  const reasons = {
    1: '권한 거부',
    2: '위치 확인 불가',
    3: '응답 시간 초과',
  };
  return reasons[error.code] || `알 수 없는 오류 ${error.code}`;
}

function formatShieldRemaining(remainingMs) {
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}시간 ${minutes}분` : `${minutes}분`;
}

function hasForbiddenCredentialSequence(value) {
  const normalized = value.toLowerCase();
  const sequences = ['0123', '1234', '2345', '3456', '4567', '5678', '6789', 'abcd', 'bcde', 'cdef', 'qwer', 'wert', 'erty', 'qwerty'];
  return /(.)\1\1/.test(normalized) || sequences.some((sequence) => normalized.includes(sequence));
}

function validateSignupCredentials(username, password) {
  if (!/^[A-Za-z]{5,12}$/.test(username)) {
    return '닉네임은 영문만 사용해 5~12자로 입력하세요.';
  }
  if (!/^[A-Za-z0-9!@#$%^&*()_+\-=]+$/.test(password)) {
    return '비밀번호는 영문, 숫자, 허용된 특수문자만 사용할 수 있습니다.';
  }
  if ((password.match(/[0-9]/g) || []).length < 2) {
    return '비밀번호에는 숫자가 2개 이상 필요합니다.';
  }
  if (!/[!@#$%^&*()_+\-=]/.test(password)) {
    return '비밀번호에는 허용된 특수문자 1개 이상이 필요합니다.';
  }
  if (hasForbiddenCredentialSequence(username) || hasForbiddenCredentialSequence(password)) {
    return '1234, aaaa, qwerty처럼 연속되거나 반복되는 문자는 사용할 수 없습니다.';
  }
  return null;
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isLogin = mode === 'login';
  els.loginTab.classList.toggle('active', isLogin);
  els.signupTab.classList.toggle('active', !isLogin);
  els.authTitle.textContent = isLogin ? '로그인' : '회원가입';
  els.authDescription.textContent = isLogin ? '당신이 지나간 곳이 팀의 영역이 됩니다.' : '닉네임과 비밀번호로 세력에 합류하세요.';
  els.authSubmit.textContent = isLogin ? '로그인' : '회원가입';
  els.authPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
  els.teamSelection.hidden = isLogin;
  els.termsField.hidden = isLogin;
  els.termsAgreement.required = !isLogin;
  if (!isLogin) {
    loadTeamOptions();
  } else {
    state.selectedTeamId = '';
  }
  setAuthMessage('');
}

async function loadTeamOptions() {
  els.teamOptions.innerHTML = '<span class="team-loading">세력 정보를 불러오는 중...</span>';
  try {
    const response = await fetch('/api/teams');
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || '세력 정보를 불러오지 못했습니다.');
    }
    els.teamOptions.innerHTML = '';
    payload.teams.forEach((team) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'team-option';
      button.disabled = team.selectionDisabled;
      button.dataset.teamId = team.id;
      button.style.setProperty('--team-color', team.color);
      button.innerHTML = `<strong>${team.name}</strong><span>${team.memberCount}명${team.selectionDisabled ? ' · 인원 균형 대기' : ''}</span>`;
      button.addEventListener('click', () => {
        state.selectedTeamId = team.id;
        document.querySelectorAll('.team-option').forEach((option) => option.classList.toggle('selected', option === button));
      });
      els.teamOptions.appendChild(button);
    });
    const firstAvailable = Array.from(els.teamOptions.querySelectorAll('.team-option')).find((option) => !option.disabled);
    if (firstAvailable && !state.selectedTeamId) {
      firstAvailable.click();
    }
  } catch (error) {
    els.teamOptions.innerHTML = `<span class="team-loading">${error.message}</span>`;
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const username = els.authUsername.value.trim();
  const password = els.authPassword.value;
  if (!username || !password) {
    setAuthMessage('닉네임과 비밀번호를 입력하세요.');
    return;
  }
  if (state.authMode === 'signup' && !state.selectedTeamId) {
    setAuthMessage('가입할 세력을 선택하세요.');
    return;
  }
  if (state.authMode === 'signup') {
    const credentialError = validateSignupCredentials(username, password);
    if (credentialError) {
      setAuthMessage(credentialError);
      return;
    }
    if (!els.termsAgreement.checked) {
      setAuthMessage('이용 약관과 위치 정보 안내에 동의하세요.');
      return;
    }
  }

  els.authSubmit.disabled = true;
  setAuthMessage('처리 중...', false);
  try {
    const endpoint = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, teamId: state.selectedTeamId }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || '인증에 실패했습니다.');
    }
    localStorage.setItem('territory.token', payload.token);
    state.userId = payload.user.id;
    state.username = payload.user.username;
    state.teamColor = payload.team?.color || null;
    renderAccountInfo();
    state.teamId = payload.user.teamId || '';
    els.authScreen.hidden = true;
    els.gameScreen.hidden = false;
    initMap();
  } catch (error) {
    setAuthMessage(error.message);
  } finally {
    els.authSubmit.disabled = false;
  }
}

async function restoreSession() {
  const token = localStorage.getItem('territory.token');
  if (!token) {
    setAuthMode('login');
    return;
  }

  try {
    const response = await fetch('/api/me', { headers: authHeaders() });
    if (!response.ok) {
      throw new Error('세션이 만료되었습니다.');
    }
    const payload = await response.json();
    state.userId = payload.user.id;
    state.username = payload.user.username;
    state.teamId = payload.user.teamId || '';
    state.teamColor = payload.team?.color || null;
    renderAccountInfo();
    els.authScreen.hidden = true;
    els.gameScreen.hidden = false;
    initMap();
  } catch (error) {
    localStorage.removeItem('territory.token');
    setAuthMode('login');
  }
}

function showMapError(message) {
  document.getElementById('map').innerHTML = `<div class="map-error">${message}</div>`;
}

function historyStorageKey() {
  return `territory.locationHistory.${state.username}`;
}

function renderPaintedTileSummary() {
  const paintedTiles = Array.from(state.sharedTiles.values())
    .filter((tile) => tile.ownerUserId === state.userId);
  els.paintedTileCount.textContent = `칠한 타일 ${paintedTiles.length}개`;
  els.paintedTileList.innerHTML = '';
  paintedTiles.slice(-3).reverse().forEach((tile) => {
    const coordinates = {
      lat: tile.centerLat || (tile.south + tile.north) / 2,
      lng: tile.centerLng || (tile.west + tile.east) / 2,
    };
    const item = document.createElement('li');
    const coordinateText = document.createElement('span');
    coordinateText.textContent = `${coordinates.lat.toFixed(6)}, ${coordinates.lng.toFixed(6)}`;
    const moveButton = document.createElement('button');
    moveButton.type = 'button';
    moveButton.className = 'tile-jump-button';
    moveButton.textContent = '이동';
    moveButton.title = '이 좌표로 지도 이동';
    moveButton.addEventListener('click', () => moveMapToTile(coordinates));
    item.append(coordinateText, moveButton);
    els.paintedTileList.appendChild(item);
  });
}

function moveMapToTile(tile) {
  if (!state.map || !window.kakao?.maps) {
    return;
  }
  state.map.setCenter(new kakao.maps.LatLng(tile.lat, tile.lng));
}

function authHeaders() {
  const token = localStorage.getItem('territory.token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleUnauthorized(response) {
  if (response.status !== 401) {
    return false;
  }
  localStorage.removeItem('territory.token');
  window.location.reload();
  return true;
}

async function syncLocationToServer(location, claimPoints = []) {
  const position = { lat: location.latitude, lng: location.longitude };
  if (state.lastSyncedPosition && distanceInMeters(state.lastSyncedPosition, position) < 5 && claimPoints.length === 0) {
    return;
  }
  state.lastSyncedPosition = position;
  try {
    const response = await fetch('/api/location', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: {
          lat: location.latitude,
          lng: location.longitude,
          accuracy: location.accuracy,
          speed: location.speed,
          heading: location.heading,
          timestamp: location.timestamp,
        },
        points: claimPoints.map((point) => ({
          lat: point.latitude,
          lng: point.longitude,
          accuracy: point.accuracy,
          speed: point.speed,
          heading: point.heading,
          timestamp: point.timestamp,
        })),
      }),
    });
    if (handleUnauthorized(response)) {
      return;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (claimPoints.length) {
        showTileToast(payload.message || '타일을 점령하지 못했습니다.', 'error');
      }
      return;
    }
    const payload = await response.json();
    (payload.tiles || (payload.tile ? [payload.tile] : [])).forEach((tile) => {
      state.sharedTiles.set(tile.tileKey, tile);
    });
    if (payload.tiles?.length || payload.tile) {
      renderPaintedTileSummary();
      renderGrid(state.map);
      showTileToast(`타일 ${payload.tiles?.length || 1}개 점령 완료 · 5시간 보호`, 'success');
    }
    if (payload.blockedTiles?.length) {
      const remaining = formatShieldRemaining(payload.blockedTiles[0].remainingMs);
      updateGpsDebug(`보호막으로 점령 불가 · ${remaining} 후 가능`);
      showTileToast(`보호막으로 점령 불가 · ${remaining} 후 가능`, 'error');
    }
  } catch (error) {
    if (claimPoints.length) {
      showTileToast('네트워크 오류로 타일을 점령하지 못했습니다.', 'error');
    }
    return;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character]));
}

async function syncPlayers() {
  if (!state.map) {
    return;
  }
  try {
    const response = await fetch('/api/players', { headers: authHeaders() });
    if (handleUnauthorized(response)) {
      return;
    }
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    const activeIds = new Set(payload.players.map((player) => player.id));
    payload.players.forEach((player) => {
      if (player.id === state.userId) {
        return;
      }
      const position = new kakao.maps.LatLng(player.lat, player.lng);
      const content = document.createElement('button');
      content.type = 'button';
      content.className = 'player-label';
      content.textContent = player.username;
      content.title = state.deleteMode ? '이 사용자 계정 삭제' : player.username;
      content.addEventListener('click', () => {
        if (state.deleteMode) {
          deleteSelectedAccount(player);
        }
      });
      let overlay = state.playerOverlays.get(player.id);
      if (!overlay) {
        overlay = new kakao.maps.CustomOverlay({ position, content, yAnchor: 1.25, zIndex: 30 });
        state.playerOverlays.set(player.id, overlay);
      } else {
        overlay.setPosition(position);
        overlay.setContent(content);
      }
      overlay.setMap(state.map);
    });
    state.playerOverlays.forEach((overlay, playerId) => {
      if (!activeIds.has(playerId)) {
        overlay.setMap(null);
        state.playerOverlays.delete(playerId);
      }
    });
  } catch (error) {
    // A temporary polling failure should not stop the map.
  }
}

async function syncTeamMembers() {
  try {
    const response = await fetch('/api/team-members', { headers: authHeaders() });
    if (handleUnauthorized(response) || !response.ok) {
      return;
    }
    const payload = await response.json();
    els.teamMembersTitle.textContent = payload.team ? `${payload.team.name} 팀` : '내 팀 없음';
    els.teamMembersTitle.style.color = payload.team?.color || '';
    const onlineCount = payload.members.filter((member) => member.online).length;
    els.teamSummary.textContent = payload.team
      ? `팀원 ${payload.members.length}명 · 온라인 ${onlineCount}명`
      : '가입한 팀이 없습니다.';
    els.teamMembersList.innerHTML = '';
    payload.members.forEach((member) => {
      const item = document.createElement('li');
      const status = document.createElement('span');
      status.className = `member-status ${member.online ? 'online' : ''}`;
      status.title = member.online ? '접속 중' : '미접속';
      status.setAttribute('aria-label', member.online ? '접속 중' : '미접속');
      const name = document.createElement('span');
      name.textContent = member.username;
      item.append(status, name);
      if (state.deleteMode && member.id !== state.userId) {
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'member-delete-button';
        deleteButton.textContent = '삭제';
        deleteButton.title = `${member.username} 계정 삭제`;
        deleteButton.addEventListener('click', () => deleteSelectedAccount(member));
        item.appendChild(deleteButton);
      }
      els.teamMembersList.appendChild(item);
    });
  } catch (error) {
    // Team member polling can recover on the next interval.
  }
}

async function syncLeaderboard() {
  try {
    const response = await fetch('/api/state', { headers: authHeaders() });
    if (handleUnauthorized(response) || !response.ok) {
      return;
    }
    const payload = await response.json();
    els.leaderboardList.innerHTML = '';
    payload.leaderboard.forEach((team, index) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'leaderboard-team-name';
      name.textContent = team.name;
      name.style.color = team.color;
      const score = document.createElement('span');
      score.textContent = `${team.tiles}칸`;
      if (team.id === state.teamId) {
        item.classList.add('current-team');
      }
      item.append(name, score);
      els.leaderboardList.appendChild(item);
    });
    const currentTeam = payload.leaderboard.find((team) => team.id === state.teamId);
    if (currentTeam) {
      const currentRank = payload.leaderboard.indexOf(currentTeam) + 1;
      els.ownTeamCaptureIcon.textContent = currentRank === 1 ? '👑' : String(currentRank);
      els.ownTeamCaptureIcon.classList.toggle('first-place', currentRank === 1);
      els.ownTeamCaptureCount.textContent = currentTeam.tiles;
      els.ownTeamCaptureCount.style.color = currentTeam.color;
      const currentSummary = els.teamSummary.textContent.split(' · ')[0];
      els.teamSummary.textContent = `${currentSummary} · ${currentTeam.tiles}칸 점령 · ${currentTeam.groupPoints}점`;
    }
    els.leaderboardUpdated.textContent = `마지막 갱신 ${new Date().toLocaleTimeString('ko-KR')}`;
  } catch (error) {
    // Leaderboard polling can recover on the next interval.
  }
}

function toggleLeaderboard() {
  const isExpanded = els.leaderboardToggle.getAttribute('aria-expanded') === 'true';
  els.leaderboardToggle.setAttribute('aria-expanded', String(!isExpanded));
  els.leaderboardBody.hidden = isExpanded;
  els.leaderboardToggle.querySelector('span').textContent = isExpanded ? '펼치기' : '접기';
}

function toggleTeamMembers() {
  const isExpanded = els.teamMembersToggle.getAttribute('aria-expanded') === 'true';
  els.teamMembersToggle.setAttribute('aria-expanded', String(!isExpanded));
  els.teamMembersBody.hidden = isExpanded;
  els.teamMembersToggle.querySelector('span').textContent = isExpanded ? '펼치기' : '접기';
}

async function syncSharedTiles() {
  if (!state.map) {
    return;
  }
  const bounds = state.map.getBounds();
  const southWest = bounds.getSouthWest();
  const northEast = bounds.getNorthEast();
  try {
    const params = new URLSearchParams({
      south: String(southWest.getLat()),
      west: String(southWest.getLng()),
      north: String(northEast.getLat()),
      east: String(northEast.getLng()),
    });
    const response = await fetch(`/api/owned-tiles?${params.toString()}`, { headers: authHeaders() });
    if (handleUnauthorized(response)) {
      return;
    }
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    applyServerTileReset(payload.tileResetAt || null);
    state.sharedTiles.clear();
    payload.tiles
      .filter((tile) => tile.ownerUserId)
      .forEach((tile) => state.sharedTiles.set(tile.tileKey, tile));
    renderPaintedTileSummary();
    renderGrid(state.map);
  } catch (error) {
    // A temporary polling failure should not stop the map.
  }
}

function applyServerTileReset(resetAt) {
  if (resetAt === state.lastServerTileResetAt) {
    return;
  }

  state.lastServerTileResetAt = resetAt;
  state.sharedTiles.clear();
  renderPaintedTileSummary();
}

async function resetTilesForDevelopment() {
  if (!window.confirm('저장된 모든 타일을 초기화할까요?')) {
    return;
  }

  els.resetTilesButton.disabled = true;
  try {
    const response = await fetch('/api/dev/reset-tiles', {
      method: 'POST',
      headers: authHeaders(),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || '타일 초기화에 실패했습니다.');
    }
    applyServerTileReset(payload.tileResetAt || null);
    state.sharedTiles.clear();
    renderGrid(state.map);
  } catch (error) {
    window.alert(error.message);
  } finally {
    els.resetTilesButton.disabled = false;
  }
}

function toggleDeleteMode() {
  state.deleteMode = !state.deleteMode;
  els.deleteAccountButton.textContent = state.deleteMode ? '삭제할 사람을 클릭하세요' : '개발자 계정 삭제';
  els.deleteAccountButton.classList.toggle('active', state.deleteMode);
  syncTeamMembers();
}

async function deleteSelectedAccount(player) {
  if (!window.confirm(`${player.username} 계정과 해당 타일을 삭제할까요?`)) {
    return;
  }

  els.deleteAccountButton.disabled = true;
  try {
    const response = await fetch('/api/dev/delete-account', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: player.id }),
    });
    const payload = await response.json();
    if (handleUnauthorized(response)) {
      return;
    }
    if (!response.ok) {
      throw new Error(payload.message || '계정 삭제에 실패했습니다.');
    }
    const overlay = state.playerOverlays.get(player.id);
    overlay?.setMap(null);
    state.playerOverlays.delete(player.id);
    state.deleteMode = false;
    els.deleteAccountButton.textContent = '개발자 계정 삭제';
    els.deleteAccountButton.classList.remove('active');
    syncTeamMembers();
    syncSharedTiles();
  } catch (error) {
    window.alert(error.message);
  } finally {
    els.deleteAccountButton.disabled = false;
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
  history.slice(0, 3).forEach((location) => {
    const latitude = Number(location.lat ?? location.latitude);
    const longitude = Number(location.lng ?? location.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }
    const item = document.createElement('li');
    item.textContent = `${location.time || '시각 없음'} · ${latitude.toFixed(6)}, ${longitude.toFixed(6)} (${Math.round(Number(location.accuracy) || 0)}m)`;
    els.locationHistoryList.appendChild(item);
  });
}

function distanceInMeters(first, second) {
  const latitude = (second.lat - first.lat) * 111320;
  const longitude = (second.lng - first.lng) * 111320 * Math.cos(first.lat * Math.PI / 180);
  return Math.sqrt(latitude ** 2 + longitude ** 2);
}

function normalizeLocation(position) {
  const coords = position.coords;
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
    speed: Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed : null,
    heading: Number.isFinite(coords.heading) && coords.heading >= 0 ? coords.heading : null,
    timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
  };
}

function headingDifference(first, second) {
  if (first === null || second === null) {
    return 0;
  }
  const difference = Math.abs(first - second) % 360;
  return difference > 180 ? 360 - difference : difference;
}

function offsetLocation(location, eastMeters, northMeters) {
  return {
    ...location,
    latitude: location.latitude + northMeters / 111320,
    longitude: location.longitude + eastMeters / (111320 * Math.cos(location.latitude * Math.PI / 180)),
  };
}

function sampleSegment(start, end, sampleMeters = GPS_CONFIG.minRouteSampleMeters) {
  const startPoint = { lat: start.latitude, lng: start.longitude };
  const endPoint = { lat: end.latitude, lng: end.longitude };
  const distance = distanceInMeters(startPoint, endPoint);
  const steps = Math.max(1, Math.ceil(distance / sampleMeters));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const ratio = index / steps;
    return {
      ...end,
      latitude: start.latitude + (end.latitude - start.latitude) * ratio,
      longitude: start.longitude + (end.longitude - start.longitude) * ratio,
    };
  });
}

function interpolateRoute(previous, current) {
  if (!previous) {
    return [current];
  }

  const distance = distanceInMeters(
    { lat: previous.latitude, lng: previous.longitude },
    { lat: current.latitude, lng: current.longitude },
  );
  if (distance <= GRID_SIZE_DEGREES * 111320 * 1.5) {
    return [current];
  }

  const turn = headingDifference(previous.heading, current.heading);
  if (turn < GPS_CONFIG.headingTurnThreshold || previous.heading === null || current.heading === null) {
    return sampleSegment(previous, current);
  }

  const currentFromPrevious = offsetLocation(previous, 0, 0);
  const vectorOne = {
    x: Math.sin(previous.heading * Math.PI / 180),
    y: Math.cos(previous.heading * Math.PI / 180),
  };
  const vectorTwo = {
    x: Math.sin(current.heading * Math.PI / 180),
    y: Math.cos(current.heading * Math.PI / 180),
  };
  const target = {
    x: (current.longitude - currentFromPrevious.longitude) * 111320 * Math.cos(previous.latitude * Math.PI / 180),
    y: (current.latitude - currentFromPrevious.latitude) * 111320,
  };
  const determinant = vectorOne.x * vectorTwo.y - vectorOne.y * vectorTwo.x;
  if (Math.abs(determinant) < 0.2) {
    return [current];
  }

  const firstDistance = (target.x * vectorTwo.y - target.y * vectorTwo.x) / determinant;
  const secondDistance = (vectorOne.x * target.y - vectorOne.y * target.x) / determinant;
  if (firstDistance < 0 || secondDistance < 0 || firstDistance + secondDistance > distance * 3 + 50) {
    return [current];
  }

  const corner = offsetLocation(previous, vectorOne.x * firstDistance, vectorOne.y * firstDistance);
  return sampleSegment(previous, corner).concat(sampleSegment(corner, current).slice(1));
}

function isSuspiciousLocation(previous, current) {
  if (!previous) {
    return false;
  }
  const metrics = getMovementMetrics(previous, current);
  return (current.accuracy !== null && current.accuracy > GPS_CONFIG.maxAccuracyForClaim)
    || metrics.distance > GPS_CONFIG.maxJumpDistance
    || metrics.calculatedSpeed > GPS_CONFIG.maxSpeedMps
    || (current.speed !== null && current.speed > GPS_CONFIG.maxSpeedMps);
}

function getMovementMetrics(previous, current) {
  const elapsedSeconds = Math.max((current.timestamp - previous.timestamp) / 1000, 0.1);
  const distance = distanceInMeters(
    { lat: previous.latitude, lng: previous.longitude },
    { lat: current.latitude, lng: current.longitude },
  );
  return { distance, calculatedSpeed: distance / elapsedSeconds };
}

function isDisplayOutlier(previous, current) {
  if (!previous) {
    return false;
  }
  const metrics = getMovementMetrics(previous, current);
  return (current.accuracy !== null && current.accuracy > 250)
    || metrics.distance > GPS_CONFIG.maxDisplayJumpDistance
    || metrics.calculatedSpeed > GPS_CONFIG.maxDisplaySpeedMps;
}

function processLocation(position) {
  const current = normalizeLocation(position);
  const locationKey = `${current.timestamp}:${current.latitude.toFixed(6)}:${current.longitude.toFixed(6)}`;
  if (state.processedLocationKeys.has(locationKey)) {
    return;
  }
  state.processedLocationKeys.add(locationKey);
  if (state.processedLocationKeys.size > 100) {
    state.processedLocationKeys.delete(state.processedLocationKeys.values().next().value);
  }

  updateGpsDebug('위치 수신 중', position);
  const hasBeenIdle = Date.now() - state.lastMapInteractionAt >= LOCATION_RECENTER_IDLE_MS;
  const shouldCenter = !state.hasCenteredOnLocation || state.centerOnNextLocation || hasBeenIdle;
  state.centerOnNextLocation = false;
  const displayOutlier = isDisplayOutlier(state.previousLocation, current);
  if (!displayOutlier) {
    setPlayerPosition(state.map, current.latitude, current.longitude, shouldCenter, current.accuracy);
    state.hasCenteredOnLocation = true;
  }
  recordLocation(current);

  const suspicious = isSuspiciousLocation(state.previousLocation, current);
  const claimable = !suspicious && (current.accuracy === null || current.accuracy <= GPS_CONFIG.maxAccuracyForClaim);
  if (claimable) {
    updateGpsDebug('점령 가능', position);
  }
  let route = claimable ? interpolateRoute(state.previousClaimLocation, current) : [];
  const newTiles = [];
  const routeTileIds = new Set();
  route.forEach((point) => {
    const tileId = gridIdAt(point.latitude, point.longitude);
    if (!routeTileIds.has(tileId)) {
      routeTileIds.add(tileId);
      newTiles.push(point);
    }
  });
  syncLocationToServer(current, newTiles);
  if (claimable) {
    state.previousClaimLocation = current;
  } else {
    state.previousClaimLocation = null;
    updateGpsDebug(displayOutlier ? '위치 튐 의심 · 점령 보류' : 'GPS 정확도 부족 · 점령 보류');
  }
  state.previousLocation = current;
}

function recordLocation(location) {
  const record = {
    lat: location.latitude,
    lng: location.longitude,
    accuracy: location.accuracy || 0,
    speed: location.speed,
    heading: location.heading,
    timestamp: location.timestamp,
  };
  if (state.lastRecordedPosition && distanceInMeters(state.lastRecordedPosition, { lat: record.lat, lng: record.lng }) < 10) {
    return;
  }
  state.lastRecordedPosition = { lat: record.lat, lng: record.lng };
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem(historyStorageKey()) || '[]');
  } catch (error) {
    history = [];
  }
  history.unshift({ ...record, time: new Date(record.timestamp).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' }) });
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

function setPlayerPosition(map, lat, lng, shouldCenter = true, accuracy = null) {
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
    if (!state.hasCenteredOnLocation) {
      map.setLevel(MAX_CLAIMED_TILE_ZOOM_LEVEL);
    }
  }

  syncPlayers();
  syncSharedTiles();
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
  processLocation({
    coords: {
      latitude: state.playerPosition.lat + delta.lat,
      longitude: state.playerPosition.lng + delta.lng,
      accuracy: 1,
      speed: 2,
      heading: direction === 'right' ? 90 : direction === 'left' ? 270 : direction === 'up' ? 0 : 180,
    },
    timestamp: Date.now(),
  });
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
  processLocation({
    coords: { latitude: position.lat, longitude: position.lng, accuracy: 1, speed: 0, heading: null },
    timestamp: Date.now(),
  });
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

function renderClaimedTiles(map, bounds) {
  const nextPolygons = [];
  state.sharedTiles.forEach((tile, gridId) => {
    const centerLat = tile.centerLat || (tile.south + tile.north) / 2;
    const centerLng = tile.centerLng || (tile.west + tile.east) / 2;
    if (centerLat < bounds.getSouthWest().getLat() || centerLat > bounds.getNorthEast().getLat()
      || centerLng < bounds.getSouthWest().getLng() || centerLng > bounds.getNorthEast().getLng()) {
      return;
    }
    const polygon = new kakao.maps.Polygon({
      map: null,
      path: [
        new kakao.maps.LatLng(tile.south, tile.west),
        new kakao.maps.LatLng(tile.south, tile.east),
        new kakao.maps.LatLng(tile.north, tile.east),
        new kakao.maps.LatLng(tile.north, tile.west),
      ],
      strokeOpacity: 0,
      strokeWeight: 0,
      fillColor: tile.ownerTeamColor || '#64748b',
      fillOpacity: 0.78,
    });
    polygon.gridId = gridId;
    nextPolygons.push(polygon);
  });
  nextPolygons.forEach((polygon) => polygon.setMap(map));
  state.gridPolygons = nextPolygons;
}

function renderGrid(map) {
  const bounds = map.getBounds();
  const southWest = bounds.getSouthWest();
  const northEast = bounds.getNorthEast();
  const minLat = Math.max(KOREA_BOUNDS.minLat, southWest.getLat());
  const maxLat = Math.min(KOREA_BOUNDS.maxLat, northEast.getLat());
  const minLng = Math.max(KOREA_BOUNDS.minLng, southWest.getLng());
  const maxLng = Math.min(KOREA_BOUNDS.maxLng, northEast.getLng());

  if (map.getLevel() > MAX_CLAIMED_TILE_ZOOM_LEVEL || minLat >= maxLat || minLng >= maxLng) {
    clearGrid(map);
    setGridStatus(minLat >= maxLat || minLng >= maxLng ? '대한민국 범위 밖입니다.' : '타일을 보려면 250m 이하로 확대해 주세요.');
    return;
  }

  clearGrid(map);
  renderClaimedTiles(map, bounds);
  setGridStatus('');
}

function scheduleGridRender(map) {
  window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(() => renderGrid(map), 80);
}

function updateCurrentLocation(map, position) {
  if (state.mockMode) {
    return;
  }
  processLocation(position);
}

function requestCurrentLocation(map) {
  if (localStorage.getItem('territory.locationTracking') === 'false') {
    return;
  }
  if (navigator.geolocation) {
    updateGpsDebug('현재 위치 요청 중');
    navigator.geolocation.getCurrentPosition((position) => updateCurrentLocation(map, position), (error) => {
      updateGpsDebug(`위치 요청 실패: ${describeLocationError(error)}`);
    }, {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: LOCATION_REQUEST_TIMEOUT_MS,
    });
  }
}

function startLocationWatch(map) {
  if (localStorage.getItem('territory.locationTracking') === 'false') {
    return;
  }
  if (!navigator.geolocation || state.watchId !== null) {
    if (!navigator.geolocation) {
      updateGpsDebug('이 브라우저는 위치 기능을 지원하지 않음');
    }
    return;
  }
  updateGpsDebug('실시간 위치 감시 중');
  state.watchId = navigator.geolocation.watchPosition(
    (position) => updateCurrentLocation(map, position),
    (error) => updateGpsDebug(`실시간 위치 오류: ${describeLocationError(error)}`),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: LOCATION_REQUEST_TIMEOUT_MS },
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
    renderPaintedTileSummary();
    state.map = new kakao.maps.Map(document.getElementById('map'), {
      center: new kakao.maps.LatLng(INITIAL_MAP_CENTER.lat, INITIAL_MAP_CENTER.lng),
      level: 13,
    });
    loadLocationHistory();
    kakao.maps.event.addListener(state.map, 'idle', () => {
      scheduleGridRender(state.map);
      syncSharedTiles();
      syncPlayers();
    });
    const markMapInteraction = () => {
      state.lastMapInteractionAt = Date.now();
    };
    kakao.maps.event.addListener(state.map, 'dragstart', markMapInteraction);
    kakao.maps.event.addListener(state.map, 'zoom_changed', markMapInteraction);
    state.lastMapInteractionAt = Date.now();
    window.addEventListener('resize', () => scheduleGridRender(state.map));
    scheduleGridRender(state.map);
    state.centerOnNextLocation = true;
    requestCurrentLocation(state.map);
    startLocationWatch(state.map);
    syncPlayers();
    syncTeamMembers();
    syncLeaderboard();
    syncSharedTiles();
    state.syncTimer = window.setInterval(() => {
      syncPlayers();
      syncTeamMembers();
      syncLeaderboard();
      syncSharedTiles();
    }, 5000);
  });
}

els.loginTab.addEventListener('click', () => setAuthMode('login'));
els.signupTab.addEventListener('click', () => setAuthMode('signup'));
els.authForm.addEventListener('submit', submitAuth);
els.accountToggle.addEventListener('click', toggleAccountPanel);
els.settingsButton.addEventListener('click', openSettings);
els.settingsCloseButton.addEventListener('click', closeSettings);
els.seasonButton.addEventListener('click', openSeasonModal);
els.seasonCloseButton.addEventListener('click', closeSeasonModal);
els.locationTrackingToggle.addEventListener('change', (event) => setLocationTracking(event.target.checked));
els.fullscreenButton.addEventListener('click', toggleFullscreen);
els.gpsStatusToggle.addEventListener('click', toggleGpsStatus);
els.logoutButton.addEventListener('click', logout);
els.teamMembersToggle.addEventListener('click', toggleTeamMembers);
els.leaderboardToggle.addEventListener('click', toggleLeaderboard);
els.zoomInButton.addEventListener('click', () => {
  zoomMap(-1);
});
els.zoomOutButton.addEventListener('click', () => {
  zoomMap(1);
});
els.locationTrackingToggle.checked = localStorage.getItem('territory.locationTracking') !== 'false';
els.zoomFocusInputs.forEach((input) => {
  input.checked = input.value === getZoomFocus();
  input.addEventListener('change', () => setZoomFocus(input.value));
});
applyTheme();
els.themeInputs.forEach((input) => {
  input.checked = input.value === getTheme();
  input.addEventListener('change', () => setTheme(input.value));
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'system') {
    applyTheme();
  }
});
restoreSession();
