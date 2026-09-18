const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GRID_SIZE_DEGREES = 0.00009;
const SHIELD_MS = 90 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const REWARD_TABLE = [
  { rank: 1, personal: 50, group: 20 },
  { rank: 2, personal: 35, group: 12 },
  { rank: 3, personal: 20, group: 6 },
];

const state = {
  currentSeasonKey: null,
  finalizedSeasonKeys: new Set(),
  teams: new Map([
    ['alpha', { id: 'alpha', name: 'ALPHA', color: '#ff5b5f', groupPoints: 0, joinMethod: 'public', leaderUserId: null, memberUserIds: [], pendingUserIds: [] }],
    ['delta', { id: 'delta', name: 'DELTA', color: '#38bdf8', groupPoints: 0, joinMethod: 'public', leaderUserId: null, memberUserIds: [], pendingUserIds: [] }],
    ['charlie', { id: 'charlie', name: 'CHARLIE', color: '#f59e0b', groupPoints: 0, joinMethod: 'public', leaderUserId: null, memberUserIds: [], pendingUserIds: [] }],
  ]),
  users: new Map(),
  authByUsername: new Map(),
  sessions: new Map(),
  memberships: new Map(),
  tiles: new Map(),
  seasons: new Map(),
  clients: new Set(),
};

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

function createUser(username, password) {
  const userId = `user_${Math.random().toString(36).slice(2, 10)}`;
  const user = {
    id: userId,
    username,
    password,
    teamId: null,
    personalPoints: 0,
    groupPoints: 0,
    lastLat: null,
    lastLng: null,
    accuracyM: null,
    lastSeenAt: null,
  };

  state.users.set(userId, user);
  state.authByUsername.set(username, user);
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
      result.push(record);
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
      const { lat, lng, accuracy } = payload;
      if (!authUser || typeof lat !== 'number' || typeof lng !== 'number') {
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
      if (!team) {
        sendJson(res, 400, { message: '팀에 먼저 가입해야 점령할 수 있습니다.' });
        return;
      }

      const user = ensureUser(authUser.id, team.id);
      user.lastLat = lat;
      user.lastLng = lng;
      user.accuracyM = typeof accuracy === 'number' ? accuracy : null;

      const tile = tileFromLatLng(lat, lng);
      const record = getTileRecord(seasonKey, tile.tileKey, tile);
      const shieldActive = record.shieldExpiresAt && new Date(record.shieldExpiresAt).getTime() > Date.now();

      if (record.ownerTeamId && record.ownerTeamId !== team.id && shieldActive) {
        sendJson(res, 200, {
          message: '방어막이 활성화되어 점령이 막혔습니다.',
          captured: false,
          phase,
          seasonKey,
          tile: record,
        });
        return;
      }

      record.ownerTeamId = team.id;
      record.ownerUserId = authUser.id;
      record.claimedAt = nowIso();
      record.shieldExpiresAt = new Date(Date.now() + SHIELD_MS).toISOString();
      record.updatedAt = nowIso();

      broadcast('tile-updated', { seasonKey, tile: record });

      sendJson(res, 200, {
        message: '점령 성공',
        captured: true,
        phase,
        seasonKey,
        tile: record,
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

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    parseBody(req).then((payload) => {
      const username = String(payload.username || '').trim();
      const password = String(payload.password || '').trim();
      if (!username || !password) {
        sendJson(res, 400, { message: 'username and password are required' });
        return;
      }

      if (state.authByUsername.has(username)) {
        sendJson(res, 409, { message: '이미 존재하는 아이디입니다.' });
        return;
      }

      const user = createUser(username, password);
      const token = createSession(user.id);
      sendJson(res, 200, { token, user: { id: user.id, username: user.username, teamId: user.teamId } });
    }).catch((error) => sendJson(res, 400, { message: error.message }));
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
      sendJson(res, 200, { token, user: { id: user.id, username: user.username, teamId: user.teamId } });
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
      teams: Array.from(state.teams.values()).map(sanitizeTeam),
      activeTeamId: user ? user.teamId : null,
    });
    return;
  }

  if (pathname === '/api/teams' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }

    parseBody(req).then((payload) => {
      const name = String(payload.name || '').trim();
      const joinMethod = payload.joinMethod === 'approval' ? 'approval' : 'public';
      const color = String(payload.color || '').trim();
      if (!name) {
        sendJson(res, 400, { message: '팀 이름이 필요합니다.' });
        return;
      }

      if (isTeamColorInUse(color)) {
        sendJson(res, 409, { message: '이미 다른팀이 사용하고 있는 색 입니다' });
        return;
      }

      const exists = Array.from(state.teams.values()).some((team) => team.name.toLowerCase() === name.toLowerCase());
      if (exists) {
        sendJson(res, 409, { message: '이미 존재하는 팀 이름입니다.' });
        return;
      }

      const team = createTeam(name, joinMethod, user.id, color);
      addUserToTeam(user.id, team.id);
      sendJson(res, 200, { team: sanitizeTeam(team), userTeamId: team.id });
    }).catch((error) => sendJson(res, 400, { message: error.message }));
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
      addUserToTeam(user.id, teamId);
      sendJson(res, 200, { status: 'joined', team: sanitizeTeam(team), userTeamId: teamId });
      return;
    }

    if (team.pendingUserIds.includes(user.id)) {
      sendJson(res, 200, { status: 'pending', team: sanitizeTeam(team) });
      return;
    }

    team.pendingUserIds.push(user.id);
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
    sendJson(res, 200, { seasonKey, tiles });
    return;
  }

  if (pathname === '/api/location' && req.method === 'POST') {
    handleCapture(req, res);
    return;
  }

  sendJson(res, 404, { message: 'Unknown API route' });
}

const publicDir = path.join(__dirname, 'public');

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
  console.log(`Network sharing URL: http://192.168.45.218:${PORT}`);
});
