-- Two concurrent advances must not create two rows for the same stage and input. A failed or cancelled run does not
-- count, so a human can rerun it with the same input. Whether this index collides with older test data is checked by
-- the full integration suite (see the Task 06 notes).
create unique index stage_runs_pipeline_unique
  on stage_runs (video_id, name, input_hash)
  where status in ('queued', 'running', 'succeeded', 'needs_decision');
