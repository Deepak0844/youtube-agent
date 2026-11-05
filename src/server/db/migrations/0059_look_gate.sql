-- Phase 5d slice D2: the Look gate. The owner approves the preview pictures of a 3D story before the long native render.
-- Only widens the gate check on the append-only approvals table; no rows change and no right is granted or revoked.
alter table approvals drop constraint if exists approvals_gate_check;
alter table approvals add constraint approvals_gate_check
  check (gate in ('outline','script','cost','look','chapter','video','thumbnail','evidence','publish','comment_reply','allow_public','live_title'));
