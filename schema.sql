CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text', -- 'text', 'image', 'audio', 'video'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);