-- Import preventive types from your Excel table
-- Update the abbreviation and parameter values based on your Excel data

INSERT INTO preventive_types (abbreviation, parameter) VALUES
('C', 'Cleaning'),
('CD', 'Cleaning Ducting'),
('CDC', 'Cleaning Dust Collector'),
('CF', 'Cleaning Filter'),
('CR', 'Calibrate Refrigerant'),
('CSA', 'Check System Air'),
('CV', 'Check Valve'),
('GB', 'Grease Bearing'),
('GBL', 'Grease Ball Linkage'),
('GF', 'General Functioning'),
('GF3', 'General Functioning - 3 Month'),
('GF5', 'General Functioning - 5 Month'),
('GFA', 'General Functioning - Annual'),
('GFKB', 'General Functioning - Keyway Bearing'),
('GFKA', 'General Functioning - Keyway Annual'),
('GFKE', 'General Functioning - Keyway Emergency'),
('GFS', 'General Functioning - Seasonal'),
('GFST', 'General Functioning - Seasonal Test'),
('GFT', 'General Functioning - Test'),
('GFV', 'General Functioning - Valve'),
('GES', 'General Emergency System'),
('GL', 'Grease Lubrication'),
('GLT', 'Grease Lubrication - Test'),
('GMO', 'Grease Motor Oil'),
('GPH', 'Grease Pump Head'),
('GO', 'General Oil'),
('GT', 'General Test'),
('IH', 'Inspect Housing'),
('S', 'Service');

-- Verify the data was inserted correctly
SELECT * FROM preventive_types ORDER BY abbreviation;
