-- Runs once, when the volume is first created. The vector extension goes into every
-- database the app uses; the test database is separate so a test can never touch
-- development data.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE gc_test OWNER gc;
\connect gc_test
CREATE EXTENSION IF NOT EXISTS vector;
