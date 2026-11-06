-- Display-only rupees per US dollar; must equal the default of display.inr_rate in core/settings-registry.ts.
insert into settings (key, value, updated_by) values ('display.inr_rate', '95.05', 'system')
on conflict (key) do nothing;
