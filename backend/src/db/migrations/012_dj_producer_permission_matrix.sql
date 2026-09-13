-- 012_dj_producer_permission_matrix.sql
-- Grants the DJ and PRODUCER roles their intended operational permissions.
--
-- Reconstructed from the live production schema on project
-- qmrqkmddkveoinvspqvn: this migration was applied directly to
-- production before ever being committed to source control. This file
-- closes that repository-convergence gap. Prior to this migration, DJ
-- and PRODUCER had zero rows in role_permissions and were functionally
-- indistinguishable from LISTENER.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'DJ' AND p.code IN (
  'ai.read','audience.read','broadcast.control','broadcast.read',
  'library.read','playlist.read','queue.modify','queue.read'
)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'PRODUCER' AND p.code IN (
  'ai.control','ai.read','analytics.read','audience.moderate','audience.read',
  'broadcast.control','broadcast.read','library.read','library.upload',
  'playlist.modify','playlist.read','queue.modify','queue.read'
)
ON CONFLICT DO NOTHING;
