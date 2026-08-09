BEGIN;

CREATE TABLE public.otp_verifications (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL,
    otp_code      VARCHAR(6)   NOT NULL,
    expires_at    TIMESTAMP    NOT NULL,
    verified      BOOLEAN      DEFAULT false,
    created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_otp_email ON public.otp_verifications (email);

CREATE TABLE public.sessions (
    id            SERIAL PRIMARY KEY,
    session_token VARCHAR(255) NOT NULL UNIQUE,
    user_id       INTEGER      NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    expires_at    TIMESTAMP    NOT NULL,
    created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_session_token ON public.sessions (session_token);

CREATE TABLE public.assessment_progress (
    id               SERIAL PRIMARY KEY,
    assessor_id      INTEGER NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    ratee_id         INTEGER NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    last_question_id INTEGER REFERENCES public.questions(question_id),
    completed        BOOLEAN DEFAULT false,
    started_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(assessor_id, ratee_id)
);

CREATE INDEX idx_progress_assessor ON public.assessment_progress (assessor_id);

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;

COMMIT;
