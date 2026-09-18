CREATE TYPE season_status AS ENUM ('PLAYING', 'SETTLEMENT', 'ARCHIVED');

CREATE TABLE seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_key text NOT NULL UNIQUE,
  status season_status NOT NULL DEFAULT 'PLAYING',
  started_at timestamptz NOT NULL DEFAULT now(),
  settlement_started_at timestamptz,
  reset_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  name text NOT NULL,
  color_hex text NOT NULL,
  group_points numeric(12, 2) NOT NULL DEFAULT 0,
  total_tiles integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, name)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname text NOT NULL,
  personal_points numeric(12, 2) NOT NULL DEFAULT 0,
  group_points numeric(12, 2) NOT NULL DEFAULT 0,
  last_lat double precision,
  last_lng double precision,
  accuracy_m numeric(8, 2),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE season_team_members (
  season_id uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (season_id, team_id, user_id)
);

CREATE TABLE tile_states (
  season_id uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  tile_key text NOT NULL,
  grid_x integer NOT NULL,
  grid_y integer NOT NULL,
  center_lat double precision NOT NULL,
  center_lng double precision NOT NULL,
  owner_team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  claimed_at timestamptz,
  shield_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, tile_key)
);

CREATE INDEX idx_tile_states_owner_team ON tile_states (season_id, owner_team_id);
CREATE INDEX idx_tile_states_shield ON tile_states (season_id, shield_expires_at);

CREATE TABLE capture_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  tile_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  accuracy_m numeric(8, 2),
  captured boolean NOT NULL DEFAULT false,
  blocked_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
