/**
 * Where the accounts live.
 *
 * Both values are safe to publish. The key below is the project's `anon` key:
 * it identifies the project to the API and nothing more, because every table is
 * behind row-level security that only ever exposes the signed-in user's own row
 * (`auth.uid() = user_id`). The `service_role` key bypasses that and must never
 * appear in this file or anywhere else the browser can read.
 *
 * A reader who opens the page and never signs in sends no request at all: the
 * whole app works offline from localStorage, and sync is opt-in.
 */

export const SUPABASE_URL = 'https://ejnrmtkcigjwbubcxbgy.supabase.co';

export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqbnJtdGtjaWdqd2J1YmN4Ymd5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyNjU5NTUsImV4cCI6MjExMDg0MTk1NX0.JctBuAk3ZZDmXHA1HOGB9V8TSB1JvYzSl0vEQjNa7tU';

/** The table holding one document per account. */
export const STATE_TABLE = 'essay_reader_state';