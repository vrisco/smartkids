-- Seed de desarrollo (idempotente): matemáticas ESO-5, fracciones.
DELETE FROM redemptions;
DELETE FROM rewards;
DELETE FROM wallet_ledger;
DELETE FROM wallets;
DELETE FROM attempts;
DELETE FROM skill_progress;
DELETE FROM exercise_templates;
DELETE FROM content_packages;
DELETE FROM skill_prerequisites;
DELETE FROM skills;
DELETE FROM subjects;
DELETE FROM child_profiles;
DELETE FROM parent_accounts;

INSERT INTO subjects (id, name_i18n) VALUES
  ('math', '{"es":"Matemáticas","en":"Maths","ca":"Matemàtiques"}');

INSERT INTO skills (id, subject_id, grade_band, name_i18n, difficulty_base, position) VALUES
  ('MATH.ESO5.FRAC.EQUIV', 'math', 'ESO-5', '{"es":"Fracciones equivalentes"}', 0.3, 1),
  ('MATH.ESO5.FRAC.CMP',   'math', 'ESO-5', '{"es":"Comparar fracciones"}',     0.4, 2),
  ('MATH.ESO5.FRAC.ADD',   'math', 'ESO-5', '{"es":"Sumar fracciones"}',         0.5, 3),
  ('MATH.ESO5.FRAC.SUB',   'math', 'ESO-5', '{"es":"Restar fracciones"}',        0.55, 4);

INSERT INTO skill_prerequisites (skill_id, prerequisite_id) VALUES
  ('MATH.ESO5.FRAC.CMP', 'MATH.ESO5.FRAC.EQUIV'),
  ('MATH.ESO5.FRAC.ADD', 'MATH.ESO5.FRAC.CMP'),
  ('MATH.ESO5.FRAC.SUB', 'MATH.ESO5.FRAC.ADD');

INSERT INTO content_packages (id, subject_id, grade_band, version, status, created_at) VALUES
  ('pkg_math_eso5_v1', 'math', 'ESO-5', '1.0.0', 'published', '2026-07-11T00:00:00Z');

INSERT INTO exercise_templates (id, package_id, skill_id, type, language, content_version, stem, payload, difficulty_numeric, difficulty_level) VALUES
  ('tpl_add_1', 'pkg_math_eso5_v1', 'MATH.ESO5.FRAC.ADD', 'multiple_choice', 'es', '1.0.0',
   '1/2 + 1/3 = ?',
   '{"options":[{"id":"a","text":"5/6","isCorrect":true},{"id":"b","text":"2/5","isCorrect":false},{"id":"c","text":"1/6","isCorrect":false},{"id":"d","text":"3/6","isCorrect":false}],"feedback":{"correct":"Buscaste el denominador comun.","incorrect":"Recuerda igualar denominadores."}}',
   0.5, 'medium'),
  ('tpl_add_2', 'pkg_math_eso5_v1', 'MATH.ESO5.FRAC.ADD', 'multiple_choice', 'es', '1.0.0',
   '1/4 + 2/4 = ?',
   '{"options":[{"id":"a","text":"3/4","isCorrect":true},{"id":"b","text":"3/8","isCorrect":false},{"id":"c","text":"2/4","isCorrect":false},{"id":"d","text":"1/2","isCorrect":false}],"feedback":{"correct":"Mismo denominador: suma numeradores.","incorrect":"Mismo denominador: suma solo los de arriba."}}',
   0.35, 'easy'),
  ('tpl_equiv_1', 'pkg_math_eso5_v1', 'MATH.ESO5.FRAC.EQUIV', 'multiple_choice', 'es', '1.0.0',
   'Que fraccion equivale a 1/2?',
   '{"options":[{"id":"a","text":"2/4","isCorrect":true},{"id":"b","text":"1/3","isCorrect":false},{"id":"c","text":"2/3","isCorrect":false},{"id":"d","text":"3/4","isCorrect":false}],"feedback":{"correct":"Multiplicaste arriba y abajo por 2.","incorrect":"Multiplica numerador y denominador por el mismo numero."}}',
   0.25, 'easy');

-- Familia demo: email demo@smartkids.dev / contraseña demo1234 ; hijo Lucía con PIN 1234.
INSERT INTO parent_accounts (id, email, password_hash, locale_format, created_at) VALUES
  ('par_demo', 'demo@smartkids.dev', '521be1f5a3a1240e43727cd5a4f33a9a:ccbe41ddc77a1febbb5fc8cd1d5f890f175da511f4f5a18aa721c44926858fbd', 'es-ES', '2026-07-11T00:00:00Z');

INSERT INTO child_profiles (id, parent_id, display_name, avatar, birth_year, grade_band, login_pin_hash, preferred_locale, region) VALUES
  ('kid_demo', 'par_demo', 'Lucia', 'orbi', 2015, 'ESO-5', '2388e20d990b7ef5e7020884e6b6d2f0:8171c55b260c909b138ccf920c1ca9b62fc106961f7994584611f81da151e913', 'es', 'ES');

INSERT INTO skill_progress (profile_id, skill_id, mastery_score, consecutive_correct, total_attempts, status, fsrs) VALUES
  ('kid_demo', 'MATH.ESO5.FRAC.EQUIV', 0.9,  5, 12, 'mastered',   NULL),
  ('kid_demo', 'MATH.ESO5.FRAC.CMP',   0.82, 4, 10, 'mastered',   NULL),
  ('kid_demo', 'MATH.ESO5.FRAC.ADD',   0.4,  2,  6, 'inProgress', NULL),
  ('kid_demo', 'MATH.ESO5.FRAC.SUB',   0.0,  0,  0, 'locked',     NULL);

INSERT INTO wallets (profile_id, balance) VALUES ('kid_demo', 340);

INSERT INTO wallet_ledger (id, profile_id, delta, reason, ts) VALUES
  ('led_1', 'kid_demo', 20, 'daily_goal', '2026-07-11T09:00:00Z');

INSERT INTO rewards (id, cost, type, payload, name_i18n) VALUES
  ('reward_casco',    250, 'cosmetic',            '{"item":"casco_nebula"}', '{"es":"Casco Nebula para Orbi"}'),
  ('reward_escudo',   150, 'streak_freeze',       '{"days":1}',              '{"es":"Escudo de racha"}'),
  ('reward_screen30', 500, 'screen_time_voucher', '{"minutes":30}',          '{"es":"+30 min de pantalla"}');
