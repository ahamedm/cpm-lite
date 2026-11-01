-- Synthetic demo reference data for the Kaggle Budget vs Actual dataset.
-- Departments match gold.dim_department; cost centres are synthetic because the
-- dataset has no cost-centre column.

INSERT INTO orchestrator.department (department_code, department_name) VALUES
  ('finance', 'Finance'),
  ('hr', 'HR'),
  ('it', 'IT'),
  ('marketing', 'Marketing'),
  ('operations', 'Operations'),
  ('sales', 'Sales')
ON CONFLICT (department_code) DO NOTHING;

INSERT INTO orchestrator.cost_centre (cost_centre_code, department_code, cost_centre_name) VALUES
  ('cc_finance', 'finance', 'Finance Operations'),
  ('cc_hr', 'hr', 'People Operations'),
  ('cc_it', 'it', 'IT Operations'),
  ('cc_marketing', 'marketing', 'Marketing Operations'),
  ('cc_operations', 'operations', 'Operations'),
  ('cc_sales', 'sales', 'Sales Operations')
ON CONFLICT (cost_centre_code) DO NOTHING;
