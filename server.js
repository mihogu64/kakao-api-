const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const GRID_SIZE_DEGREES = 0.00009;
const SHIELD_MS = 90 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TEAM_BALANCE_LIMIT = 5;

const FIXED_TEAM_DEFINITIONS = [
  { id: 'red', name: '레드', color: '#FF3B30' },
  { id: 'blue', name: '블루', color: '#007AFF' },
  { id: 'green', name: '그린', color: '#34C759' },
];

const REWARD_TABLE = [
  { rank: 1, personal: 50, group: 20 },
  { rank: 2, personal: 35, group: 12 },
  { rank: 3, personal: 20, group: 6 },
];

const state = {
  currentSeasonKey: null,
  tileResetAt: null,
  finalizedSeasonKeys: new Set(),
  teams: new Map(FIXED_TEAM_DEFINITIONS.map((team) => [team.id, {
    ...team,
    groupPoints: 0,
    joinMethod: 'public',
    leaderUserId: null,
    memberUserIds: [],
    pendingUserIds: [],
  }])),
  users: new Map(),
  authByUsername: new Map(),
  sessions: new Map(),
  memberships: new Map(),
  tiles: new Map(),
  seasons: new Map(),
  clients: new Set(),
};

function savePersistentState() {
  const snapshot = {
    currentSeasonKey: state.currentSeasonKey,
    tileResetAt: state.tileResetAt,
    users: Array.from(state.users.values()),
    teams: Array.from(state.teams.values()),
    tiles: Array.from(state.tiles.values()),
    seasons: Array.from(state.seasons.values()),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
}

function loadPersistentState() {
  if (!fs.existsSync(DATA_FILE)) {
    return;
  }

  try {
    const snapshot = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const legacyTeamIds = { alpha: 'red', delta: 'blue', charlie: 'green' };
    (snapshot.users || []).forEach((user) => {
      user.teamId = legacyTeamIds[user.teamId] || user.teamId;
      state.users.set(user.id, user);
      state.authByUsername.set(user.username, user);
      if (user.teamId) {
        state.memberships.set(user.id, user.teamId);
      }
    });
    (snapshot.teams || []).forEach((team) => {
      const fixedTeamId = legacyTeamIds[team.id] || team.id;
      if (state.teams.has(fixedTeamId)) {
        state.teams.set(fixedTeamId, {
          ...state.teams.get(fixedTeamId),
          ...team,
          id: fixedTeamId,
          name: FIXED_TEAM_DEFINITIONS.find((definition) => definition.id === fixedTeamId).name,
          color: FIXED_TEAM_DEFINITIONS.find((definition) => definition.id === fixedTeamId).color,
          memberUserIds: [],
          pendingUserIds: [],
        });
      }
    });
    state.users.forEach((user) => {
      const team = state.teams.get(user.teamId);
      if (team) {
        team.memberUserIds.push(user.id);
        state.memberships.set(user.id, team.id);
      } else {
        user.teamId = null;
      }
    });
    (snapshot.tiles || []).forEach((tile) => {
      tile.ownerTeamId = legacyTeamIds[tile.ownerTeamId] || tile.ownerTeamId;
      state.tiles.set(`${tile.seasonKey}:${tile.tileKey}`, tile);
    });
    (snapshot.seasons || []).forEach((season) => state.seasons.set(season.seasonKey, season));
    state.currentSeasonKey = snapshot.currentSeasonKey || null;
    state.tileResetAt = snapshot.tileResetAt || null;
  } catch (error) {
    console.error(`Persistent state could not be loaded: ${error.message}`);
  }
}

function toKstParts(date = new Date()) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth(),
    day: kst.getUTCDate(),
    dayOfWeek: kst.getUTCDay(),
    hours: kst.getUTCHours(),
    minutes: kst.getUTCMinutes(),
    seconds: kst.getUTCSeconds(),
    millis: kst.getUTCMilliseconds(),
  };
}

function formatKstDate(parts) {
  const month = String(parts.month + 1).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

function startOfWeekKey(date = new Date()) {
  const parts = toKstParts(date);
  const kstDateUtc = Date.UTC(parts.year, parts.month, parts.day);
  const kstDate = new Date(kstDateUtc);
  const diffToMonday = (parts.dayOfWeek + 6) % 7;
  kstDate.setUTCDate(kstDate.getUTCDate() - diffToMonday);
  return formatKstDate(toKstParts(kstDate));
}

function getSeasonPhase(date = new Date()) {
  const parts = toKstParts(date);
  const minutes = parts.hours * 60 + parts.minutes;
  if (parts.dayOfWeek === 0 && minutes >= 23 * 60 + 30) {
    return 'SETTLEMENT';
  }
  return 'PLAY';
}

function nowIso() {
  return new Date().toISOString();
}

const PASSWORD_SPECIALS = '!@#$%^&*()_+-=';

function hasForbiddenSequence(value) {
  const normalized = value.toLowerCase();
  const sequences = ['0123', '1234', '2345', '3456', '4567', '5678', '6789', 'abcd', 'bcde', 'cdef', 'qwer', 'wert', 'erty', 'qwerty'];
  return /(.)\1\1/.test(normalized) || sequences.some((sequence) => normalized.includes(sequence));
}

function validateCredentials(username, password) {
  if (!/^[A-Za-z]{5,12}$/.test(username)) {
    return '닉네임은 영문만 사용해 5~12자로 입력하세요.';
  }
  if (!/^[A-Za-z0-9!@#$%^&*()_+\-=]+$/.test(password)) {
    return '비밀번호는 영문, 숫자, 허용된 특수문자만 사용할 수 있습니다.';
  }
  if ((password.match(/[0-9]/g) || []).length < 2) {
    return '비밀번호에는 숫자가 2개 이상 필요합니다.';
  }
  if ((password.match(/[!@#$%^&*()_+\-=]/g) || []).length < 1) {
    return `비밀번호에는 특수문자(${PASSWORD_SPECIALS}) 중 1개 이상이 필요합니다.`;
  }
  if (hasForbiddenSequence(username) || hasForbiddenSequence(password)) {
    return '1234, aaaa, qwerty처럼 연속되거나 반복되는 문자는 사용할 수 없습니다.';
  }
  return null;
}

function tileFromLatLng(lat, lng) {
  const gridX = Math.floor(lng / GRID_SIZE_DEGREES);
  const gridY = Math.floor(lat / GRID_SIZE_DEGREES);
  const west = gridX * GRID_SIZE_DEGREES;
  const south = gridY * GRID_SIZE_DEGREES;
  const east = (gridX + 1) * GRID_SIZE_DEGREES;
  const north = (gridY + 1) * GRID_SIZE_DEGREES;
  return {
    tileKey: `${gridX}:${gridY}`,
    gridX,
    gridY,
    south,
    west,
    north,
    east,
    centerLat: south + GRID_SIZE_DEGREES / 2,
    centerLng: west + GRID_SIZE_DEGREES / 2,
  };
}

function splitPoints(total, memberCount) {
  if (!memberCount) {
    return [];
  }

  const totalCents = Math.round(total * 100);
  const base = Math.floor(totalCents / memberCount);
  const remainder = totalCents % memberCount;

  return Array.from({ length: memberCount }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

function ensureSeason(seasonKey) {
  if (!state.seasons.has(seasonKey)) {
    state.seasons.set(seasonKey, {
      seasonKey,
      status: 'PLAYING',
      startedAt: nowIso(),
      settlementStartedAt: null,
      resetAt: null,
      finalizedAt: null,
      winners: [],
    });
  }
  state.currentSeasonKey = seasonKey;
}

function createToken() {
  return `tk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function sanitizeTeam(team) {
  if (!team) {
    return null;
  }

  const memberUsers = team.memberUserIds.map((userId) => getUserById(userId)).filter(Boolean);
  const pendingUsers = team.pendingUserIds.map((userId) => getUserById(userId)).filter(Boolean);

  return {
    id: team.id,
    name: team.name,
    color: team.color,
    groupPoints: team.groupPoints,
    joinMethod: team.joinMethod,
    leaderUserId: team.leaderUserId,
    memberCount: team.memberUserIds.length,
    pendingCount: team.pendingUserIds.length,
    members: memberUsers.map((user) => ({ id: user.id, username: user.username })),
    pendingRequests: pendingUsers.map((user) => ({ id: user.id, username: user.username })),
  };
}

function getTeamMemberCount(teamId) {
  return Array.from(state.users.values()).filter((user) => user.teamId === teamId).length;
}

function getTeamSelectionOptions() {
  const counts = FIXED_TEAM_DEFINITIONS.map((team) => ({
    team,
    memberCount: getTeamMemberCount(team.id),
  }));
  const maxCount = Math.max(...counts.map((entry) => entry.memberCount), 0);
  const minCount = Math.min(...counts.map((entry) => entry.memberCount));
  const balancingActive = maxCount - minCount >= TEAM_BALANCE_LIMIT;

  return counts.map(({ team, memberCount }) => ({
    id: team.id,
    name: team.name,
    color: team.color,
    memberCount,
    selectionDisabled: balancingActive && memberCount === maxCount,
  }));
}

function isTeamColorInUse(color, excludeTeamId = null) {
  const normalizedColor = String(color || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalizedColor)) {
    return false;
  }

  return Array.from(state.teams.values()).some((team) => {
    if (excludeTeamId && team.id === excludeTeamId) {
      return false;
    }

    return String(team.color || '').trim().toLowerCase() === normalizedColor;
  });
}

function getUserById(userId) {
  return Array.from(state.users.values()).find((user) => user.id === userId) || null;
}

function getAuthUser(req) {
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const token = bearer || req.headers['x-auth-token'] || '';
  const session = state.sessions.get(token);
  if (!session) {
    return null;
  }

  return getUserById(session.userId);
}

function ensureUser(userId, teamId) {
  if (!state.users.has(userId)) {
    state.users.set(userId, {
      id: userId,
      teamId,
      personalPoints: 0,
      groupPoints: 0,
      lastLat: null,
      lastLng: null,
      accuracyM: null,
      lastSeenAt: null,
    });
  }

  const user = state.users.get(userId);
  user.teamId = teamId;
  user.lastSeenAt = nowIso();
  state.memberships.set(userId, teamId);
  const team = state.teams.get(teamId);
  if (team && !team.memberUserIds.includes(userId)) {
    team.memberUserIds.push(userId);
  }
  return user;
}

function getTeamMembers(teamId) {
  const team = state.teams.get(teamId);
  if (!team) {
    return [];
  }

  return team.memberUserIds.map((userId) => state.users.get(userId)).filter(Boolean);
}

function addUserToTeam(userId, teamId) {
  const user = getUserById(userId);
  const team = state.teams.get(teamId);
  if (!user || !team) {
    return null;
  }

  const previousTeamId = user.teamId;
  if (previousTeamId && previousTeamId !== teamId) {
    const previousTeam = state.teams.get(previousTeamId);
    if (previousTeam) {
      previousTeam.memberUserIds = previousTeam.memberUserIds.filter((id) => id !== userId);
    }
  }

  user.teamId = teamId;
  state.memberships.set(userId, teamId);
  if (!team.memberUserIds.includes(userId)) {
    team.memberUserIds.push(userId);
  }
  team.pendingUserIds = team.pendingUserIds.filter((id) => id !== userId);
  return user;
}

function createUser(username, password, teamId = null) {
  const userId = `user_${Math.random().toString(36).slice(2, 10)}`;
  const user = {
    id: userId,
    username,
    password,
    createdAt: nowIso(),
    teamId,
    personalPoints: 0,
    groupPoints: 0,
    lastLat: null,
    lastLng: null,
    accuracyM: null,
    lastSeenAt: null,
  };

  state.users.set(userId, user);
  state.authByUsername.set(username, user);
  if (teamId) {
    addUserToTeam(userId, teamId);
  }
  savePersistentState();
  return user;
}

function createSession(userId) {
  const token = createToken();
  state.sessions.set(token, { userId, createdAt: nowIso() });
  return token;
}

function createTeam(name, joinMethod, leaderUserId, color) {
  const id = `team_${Math.random().toString(36).slice(2, 8)}`;
  const team = {
    id,
    name,
    color: /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`,
    groupPoints: 0,
    joinMethod,
    leaderUserId,
    memberUserIds: leaderUserId ? [leaderUserId] : [],
    pendingUserIds: [],
  };

  state.teams.set(id, team);
  if (leaderUserId) {
    state.memberships.set(leaderUserId, id);
  }
  return team;
}

function getTileRecord(seasonKey, tileKey, fallbackTile) {
  const key = `${seasonKey}:${tileKey}`;
  if (!state.tiles.has(key)) {
    state.tiles.set(key, {
      seasonKey,
      tileKey,
      gridX: fallbackTile.gridX,
      gridY: fallbackTile.gridY,
      south: fallbackTile.south,
      west: fallbackTile.west,
      north: fallbackTile.north,
      east: fallbackTile.east,
      centerLat: fallbackTile.centerLat,
      centerLng: fallbackTile.centerLng,
      ownerTeamId: null,
      ownerUserId: null,
      shieldExpiresAt: null,
      claimedAt: null,
      updatedAt: nowIso(),
    });
  }

  return state.tiles.get(key);
}

function getVisibleTiles(seasonKey, centerLat, centerLng, radius = 2) {
  const center = tileFromLatLng(centerLat, centerLng);
  const result = [];

  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const tileKey = `${center.gridX + dx}:${center.gridY + dy}`;
      const tile = tileFromLatLng(
        (center.gridY + dy) * GRID_SIZE_DEGREES,
        (center.gridX + dx) * GRID_SIZE_DEGREES,
      );
      const record = getTileRecord(seasonKey, tileKey, tile);
      result.push({
        ...record,
        ownerTeamColor: record.ownerTeamId ? state.teams.get(record.ownerTeamId)?.color || null : null,
      });
    }
  }

  return result;
}

function finalizeSeason(seasonKey) {
  if (state.finalizedSeasonKeys.has(seasonKey)) {
    return state.seasons.get(seasonKey);
  }

  const teamCounts = Array.from(state.teams.values()).map((team) => {
    const tileCount = Array.from(state.tiles.values()).filter(
      (tile) => tile.seasonKey === seasonKey && tile.ownerTeamId === team.id,
    ).length;

    return { team, tileCount };
  });

  teamCounts.sort((left, right) => right.tileCount - left.tileCount);

  const winners = teamCounts.slice(0, 3).map((entry, index) => {
    const reward = REWARD_TABLE[index];
    return {
      rank: reward.rank,
      teamId: entry.team.id,
      teamName: entry.team.name,
      tileCount: entry.tileCount,
      reward,
    };
  });

  winners.forEach((winner) => {
    const members = getTeamMembers(winner.teamId);
    const personalShares = splitPoints(winner.reward.personal, members.length);
    const groupShares = splitPoints(winner.reward.group, members.length);

    members.forEach((member, index) => {
      member.personalPoints += personalShares[index] || 0;
      member.groupPoints += groupShares[index] || 0;
    });

    const team = state.teams.get(winner.teamId);
    if (team) {
      team.groupPoints += winner.reward.group;
    }
  });

  const season = state.seasons.get(seasonKey) || {
    seasonKey,
    status: 'PLAYING',
    startedAt: nowIso(),
  };

  season.status = 'SETTLEMENT';
  season.settlementStartedAt = season.settlementStartedAt || nowIso();
  season.finalizedAt = nowIso();
  season.winners = winners;
  season.resetAt = season.resetAt || null;
  state.seasons.set(seasonKey, season);
  state.finalizedSeasonKeys.add(seasonKey);
  return season;
}

function resetIfNeeded(date = new Date()) {
  const seasonKey = startOfWeekKey(date);
  if (state.currentSeasonKey !== seasonKey) {
    state.currentSeasonKey = seasonKey;
    ensureSeason(seasonKey);
  }

  if (getSeasonPhase(date) === 'SETTLEMENT') {
    finalizeSeason(seasonKey);
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendSse(client, event, data) {
  client.write(`event: ${event}\n`);
  client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of state.clients) {
    sendSse(client, event, data);
  }
}

function getLeaderboard(seasonKey) {
  return Array.from(state.teams.values())
    .map((team) => ({
      id: team.id,
      name: team.name,
      color: team.color,
      tiles: Array.from(state.tiles.values()).filter(
        (tile) => tile.seasonKey === seasonKey && tile.ownerTeamId === team.id,
      ).length,
      groupPoints: team.groupPoints,
    }))
    .sort((left, right) => right.tiles - left.tiles)
    .slice(0, 3);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

function proxyKakaoSdk(req, res, search = '') {
  const remoteUrl = `https://dapi.kakao.com/v2/maps/sdk.js${search || ''}`;
  https
    .get(remoteUrl, (remoteRes) => {
      if (remoteRes.statusCode !== 200) {
        res.writeHead(502, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end('console.error("Kakao SDK proxy failed");');
        remoteRes.resume();
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });

      remoteRes.pipe(res);
    })
    .on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('console.error("Kakao SDK proxy failed");');
    });
}

function handleCapture(req, res) {
  parseBody(req)
    .then((payload) => {
      const authUser = getAuthUser(req);
      const points = Array.isArray(payload.points) ? payload.points : [payload];
      const currentPoint = payload.location || points[points.length - 1];
      if (!authUser || !currentPoint || typeof currentPoint.lat !== 'number' || typeof currentPoint.lng !== 'number') {
        sendJson(res, 401, { message: '로그인이 필요합니다.' });
        return;
      }

      resetIfNeeded(new Date());
      const seasonKey = state.currentSeasonKey;
      const phase = getSeasonPhase(new Date());

      if (phase === 'SETTLEMENT') {
        sendJson(res, 409, { message: '정산 중입니다.', phase });
        return;
      }

      const team = authUser.teamId ? state.teams.get(authUser.teamId) : null;
      const user = ensureUser(authUser.id, team ? team.id : null);
      user.lastLat = currentPoint.lat;
      user.lastLng = currentPoint.lng;
      user.accuracyM = typeof currentPoint.accuracy === 'number' ? currentPoint.accuracy : null;
      user.lastSpeed = typeof currentPoint.speed === 'number' ? currentPoint.speed : null;
      user.lastHeading = typeof currentPoint.heading === 'number' ? currentPoint.heading : null;
      user.lastLocationTimestamp = typeof currentPoint.timestamp === 'number' ? currentPoint.timestamp : Date.now();
      user.lastSeenAt = nowIso();

      const capturedTiles = [];
      const capturedTileKeys = new Set();
      points.forEach((point) => {
        if (typeof point.lat !== 'number' || typeof point.lng !== 'number') {
          return;
        }
        const tile = tileFromLatLng(point.lat, point.lng);
        if (capturedTileKeys.has(tile.tileKey)) {
          return;
        }
        capturedTileKeys.add(tile.tileKey);
        const record = getTileRecord(seasonKey, tile.tileKey, tile);
        record.ownerTeamId = team ? team.id : null;
        record.ownerUserId = authUser.id;
        record.claimedAt = nowIso();
        record.shieldExpiresAt = new Date(Date.now() + SHIELD_MS).toISOString();
        record.updatedAt = nowIso();
        capturedTiles.push({
          ...record,
          ownerTeamColor: team ? team.color : null,
        });
      });

      savePersistentState();
      capturedTiles.forEach((tile) => broadcast('tile-updated', { seasonKey, tile }));

      sendJson(res, 200, {
        message: capturedTiles.length ? '타일 저장 성공' : '위치 저장 성공',
        captured: capturedTiles.length > 0,
        phase,
        seasonKey,
        tile: capturedTiles[capturedTiles.length - 1] || null,
        tiles: capturedTiles,
      });
    })
    .catch((error) => {
      sendJson(res, 400, { message: error.message });
    });
}

function handleApi(req, res, pathname, query) {
  resetIfNeeded(new Date());
  const seasonKey = state.currentSeasonKey;
  const phase = getSeasonPhase(new Date());

  if (pathname === '/api/dev/users' && req.method === 'GET') {
    const users = Array.from(state.users.values()).map((user) => ({
      username: user.username,
      createdAt: user.createdAt || null,
    }));
    sendJson(res, 200, { users });
    return;
  }

  if (pathname === '/api/dev/reset-tiles' && req.method === 'POST') {
    const authUser = getAuthUser(req);
    if (!authUser) {
      sendJson(res, 401, { message: '로그인이 필요합니다.' });
      return;
    }

    state.tiles.clear();
    state.tileResetAt = nowIso();
    savePersistentState();
    broadcast('tiles-reset', { at: state.tileResetAt });
    sendJson(res, 200, { message: '모든 타일을 초기화했습니다.', tileResetAt: state.tileResetAt });
    return;
  }

  if (pathname === '/api/dev/delete-account' && req.method === 'POST') {
    const authUser = getAuthUser(req);
    if (!authUser) {
      sendJson(res, 401, { message: '로그인이 필요합니다.' });
      return;
    }

    parseBody(req).then((payload) => {
      const targetUserId = String(payload.userId || authUser.id).trim();
      const targetUser = getUserById(targetUserId);
      if (!targetUser) {
        sendJson(res, 404, { message: '삭제할 사용자를 찾을 수 없습니다.' });
        return;
      }

      const team = targetUser.teamId ? state.teams.get(targetUser.teamId) : null;
      if (team) {
        team.memberUserIds = team.memberUserIds.filter((userId) => userId !== targetUser.id);
        team.pendingUserIds = team.pendingUserIds.filter((userId) => userId !== targetUser.id);
      }
      state.users.delete(targetUser.id);
      state.authByUsername.delete(targetUser.username);
      state.memberships.delete(targetUser.id);
      for (const [token, session] of state.sessions.entries()) {
        if (session.userId === targetUser.id) {
          state.sessions.delete(token);
        }
      }
      for (const [tileKey, tile] of state.tiles.entries()) {
        if (tile.ownerUserId === targetUser.id) {
          state.tiles.delete(tileKey);
        }
      }
      savePersistentState();
      broadcast('player-deleted', { userId: targetUser.id });
      sendJson(res, 200, { message: '개발자 계정을 삭제했습니다.', deletedUserId: targetUser.id });
    }).catch((error) => sendJson(res, 400, { message: error.message }));
    return;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    parseBody(req).then((payload) => {
      const username = String(payload.username || '').trim();
      const password = String(payload.password || '').trim();
      const teamId = String(payload.teamId || '').trim();
      if (!username || !password) {
        sendJson(res, 400, { message: 'username and password are required' });
        return;
      }

      const credentialError = validateCredentials(username, password);
      if (credentialError) {
        sendJson(res, 400, { message: credentialError });
        return;
      }

      const teamOption = getTeamSelectionOptions().find((team) => team.id === teamId);
      if (!teamOption) {
        sendJson(res, 400, { message: '가입할 팀을 선택하세요.' });
        return;
      }
      if (teamOption.selectionDisabled) {
        sendJson(res, 409, { message: '현재 인원이 많은 팀은 잠시 선택할 수 없습니다.' });
        return;
      }

      if (state.authByUsername.has(username)) {
        sendJson(res, 409, { message: '이미 존재하는 아이디입니다.' });
        return;
      }

      const user = createUser(username, password, teamId);
      const token = createSession(user.id);
      sendJson(res, 200, { token, user: { id: user.id, username: user.username, teamId: user.teamId }, team: sanitizeTeam(state.teams.get(teamId)) });
    }).catch((error) => sendJson(res, 400, { message: error.message }));
    return;
  }

  if (pathname === '/api/players' && req.method === 'GET') {
    const authUser = getAuthUser(req);
    if (!authUser) {
      sendJson(res, 401, { message: '로그인이 필요합니다.' });
      return;
    }

    const activeSince = Date.now() - 5 * 60 * 1000;
    const players = Array.from(state.users.values())
      .filter((user) => user.lastLat !== null && user.lastLng !== null && user.lastSeenAt && new Date(user.lastSeenAt).getTime() >= activeSince)
      .map((user) => ({
        id: user.id,
        username: user.username,
        teamId: user.teamId,
        lat: user.lastLat,
        lng: user.lastLng,
        accuracyM: user.accuracyM,
        speed: user.lastSpeed ?? null,
        heading: user.lastHeading ?? null,
        locationTimestamp: user.lastLocationTimestamp ?? null,
        lastSeenAt: user.lastSeenAt,
      }));
    sendJson(res, 200, { players });
    return;
  }

  if (pathname === '/api/team-members' && req.method === 'GET') {
    const authUser = getAuthUser(req);
    if (!authUser) {
      sendJson(res, 401, { message: '로그인이 필요합니다.' });
      return;
    }

    const team = authUser.teamId ? state.teams.get(authUser.teamId) : null;
    const members = team
      ? team.memberUserIds.map((userId) => getUserById(userId)).filter(Boolean).map((user) => ({
        id: user.id,
        username: user.username,
        online: Boolean(user.lastSeenAt && new Date(user.lastSeenAt).getTime() >= Date.now() - 5 * 60 * 1000),
      }))
      : [];
    sendJson(res, 200, {
      team: team ? { id: team.id, name: team.name, color: team.color } : null,
      members,
    });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    parseBody(req).then((payload) => {
      const username = String(payload.username || '').trim();
      const password = String(payload.password || '').trim();
      const user = state.authByUsername.get(username);
      if (!user || user.password !== password) {
        sendJson(res, 401, { message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        return;
      }

      const token = createSession(user.id);
      sendJson(res, 200, {
        token,
        user: { id: user.id, username: user.username, teamId: user.teamId },
        team: sanitizeTeam(user.teamId ? state.teams.get(user.teamId) : null),
      });
    }).catch((error) => sendJson(res, 400, { message: error.message }));
    return;
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }

    const team = user.teamId ? state.teams.get(user.teamId) : null;
    sendJson(res, 200, {
      user: {
        id: user.id,
        username: user.username,
        teamId: user.teamId,
        personalPoints: user.personalPoints,
        groupPoints: user.groupPoints,
      },
      team: sanitizeTeam(team),
    });
    return;
  }

  if (pathname === '/api/teams' && req.method === 'GET') {
    const user = getAuthUser(req);
    sendJson(res, 200, {
      teams: getTeamSelectionOptions(),
      activeTeamId: user ? user.teamId : null,
    });
    return;
  }

  if (pathname === '/api/teams' && req.method === 'POST') {
    sendJson(res, 405, { message: '팀은 시스템에 고정되어 있어 새로 만들 수 없습니다.' });
    return;
  }

  if (pathname.match(/^\/api\/teams\/[^/]+\/join$/) && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }

    const teamId = pathname.split('/')[3];
    const team = state.teams.get(teamId);
    if (!team) {
      sendJson(res, 404, { message: '팀을 찾을 수 없습니다.' });
      return;
    }

    if (team.joinMethod === 'public') {
      const teamOption = getTeamSelectionOptions().find((option) => option.id === teamId);
      if (teamOption?.selectionDisabled) {
        sendJson(res, 409, { message: '현재 인원이 많은 팀은 잠시 선택할 수 없습니다.' });
        return;
      }
      addUserToTeam(user.id, teamId);
      savePersistentState();
      sendJson(res, 200, { status: 'joined', team: sanitizeTeam(team), userTeamId: teamId });
      return;
    }

    if (team.pendingUserIds.includes(user.id)) {
      sendJson(res, 200, { status: 'pending', team: sanitizeTeam(team) });
      return;
    }

    team.pendingUserIds.push(user.id);
    savePersistentState();
    sendJson(res, 200, { status: 'requested', team: sanitizeTeam(team) });
    return;
  }

  if (pathname.match(/^\/api\/teams\/[^/]+\/approve$/) && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }

    parseBody(req).then((payload) => {
      const teamId = pathname.split('/')[3];
      const applicantUserId = String(payload.userId || '').trim();
      const team = state.teams.get(teamId);
      if (!team) {
        sendJson(res, 404, { message: '팀을 찾을 수 없습니다.' });
        return;
      }

      if (team.leaderUserId !== user.id) {
        sendJson(res, 403, { message: '팀장만 승인할 수 있습니다.' });
        return;
      }

      if (!team.pendingUserIds.includes(applicantUserId)) {
        sendJson(res, 400, { message: '대기 중인 신청이 아닙니다.' });
        return;
      }

      addUserToTeam(applicantUserId, teamId);
      savePersistentState();
      sendJson(res, 200, { status: 'approved', team: sanitizeTeam(team) });
    }).catch((error) => sendJson(res, 400, { message: error.message }));
    return;
  }

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    sendJson(res, 200, {
      seasonKey,
      phase,
      teams: Array.from(state.teams.values()).map(sanitizeTeam),
    });
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const leaderboard = getLeaderboard(seasonKey);
    sendJson(res, 200, {
      seasonKey,
      phase,
      leaderboard,
      season: state.seasons.get(seasonKey) || null,
    });
    return;
  }

  if (pathname === '/api/tiles' && req.method === 'GET') {
    const lat = Number(query.lat);
    const lng = Number(query.lng);
    const radius = Number(query.radius || 2);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      sendJson(res, 400, { message: 'lat and lng are required' });
      return;
    }

    const tiles = getVisibleTiles(seasonKey, lat, lng, radius);
    sendJson(res, 200, { seasonKey, tiles, tileResetAt: state.tileResetAt });
    return;
  }

  if (pathname === '/api/owned-tiles' && req.method === 'GET') {
    const authUser = getAuthUser(req);
    if (!authUser) {
      sendJson(res, 401, { message: '로그인이 필요합니다.' });
      return;
    }

    const south = Number(query.south);
    const west = Number(query.west);
    const north = Number(query.north);
    const east = Number(query.east);
    if (![south, west, north, east].every(Number.isFinite) || south >= north || west >= east) {
      sendJson(res, 400, { message: '지도 범위가 필요합니다.' });
      return;
    }

    const tiles = Array.from(state.tiles.values())
      .filter((tile) => tile.seasonKey === seasonKey && tile.ownerUserId
        && tile.centerLat >= south && tile.centerLat <= north
        && tile.centerLng >= west && tile.centerLng <= east)
      .map((tile) => ({
        ...tile,
        ownerTeamColor: tile.ownerTeamId ? state.teams.get(tile.ownerTeamId)?.color || null : null,
      }));
    sendJson(res, 200, { seasonKey, tiles, tileResetAt: state.tileResetAt });
    return;
  }

  if (pathname === '/api/location' && req.method === 'POST') {
    handleCapture(req, res);
    return;
  }

  sendJson(res, 404, { message: 'Unknown API route' });
}

const publicDir = path.join(__dirname, 'public');

function getNetworkAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    const address = entries?.find((entry) => entry.family === 'IPv4' && !entry.internal);
    if (address) {
      return address.address;
    }
  }
  return 'localhost';
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname || '/';
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n');
    state.clients.add(res);
    sendSse(res, 'bootstrap', {
      seasonKey: state.currentSeasonKey,
      phase: getSeasonPhase(new Date()),
      leaderboard: getLeaderboard(state.currentSeasonKey),
    });

    req.on('close', () => {
      state.clients.delete(res);
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, query);
    return;
  }

  if (pathname === '/kakao-sdk.js') {
    proxyKakaoSdk(req, res, parsedUrl.search || '');
    return;
  }

  const assetPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(publicDir, assetPath);
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(res, filePath, contentTypes[extension] || 'application/octet-stream');
    return;
  }

  sendJson(res, 404, { message: 'Not found' });
});

loadPersistentState();

setInterval(() => {
  resetIfNeeded(new Date());
  const seasonKey = state.currentSeasonKey;
  const season = state.seasons.get(seasonKey);
  if (season) {
    season.status = getSeasonPhase(new Date()) === 'SETTLEMENT' ? 'SETTLEMENT' : 'PLAYING';
    if (season.status === 'SETTLEMENT' && !season.settlementStartedAt) {
      finalizeSeason(seasonKey);
      broadcast('season-updated', { seasonKey, phase: 'SETTLEMENT', season });
    }
  }
}, 15000);

ensureSeason(startOfWeekKey(new Date()));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Territory Battle server running at http://localhost:${PORT}`);
  console.log(`Network sharing URL: http://${getNetworkAddress()}:${PORT}`);
});
