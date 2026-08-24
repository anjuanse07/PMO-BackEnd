CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nickname VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) DEFAULT NULL,
  last_name VARCHAR(100) DEFAULT NULL,
  email VARCHAR(150) DEFAULT NULL,
  phone VARCHAR(50) DEFAULT NULL,
  role ENUM('manager', 'engineering supervisor', 'engineering officer', 'technician') NOT NULL,
  password VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS machines (
  no INT NOT NULL PRIMARY KEY,
  kode_mesin VARCHAR(100) NOT NULL UNIQUE,
  nama_mesin VARCHAR(255) NOT NULL,
  lokasi VARCHAR(255) DEFAULT NULL,
  departemen VARCHAR(100) DEFAULT NULL,
  kategori ENUM('MTC', 'UTY', 'BLD') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS preventive_schedule (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  machine_no INT NOT NULL,
  machine_asset VARCHAR(100) DEFAULT NULL,
  machine_name VARCHAR(255) DEFAULT NULL,
  department VARCHAR(100) DEFAULT NULL,
  location VARCHAR(255) DEFAULT NULL,
  sub ENUM('MTC', 'UTY', 'BLD') NOT NULL,
  tahun INT NOT NULL,
  bulan INT NOT NULL,
  minggu INT NOT NULL,
  tanggal_jadwal DATE DEFAULT NULL,
  execution_date DATE DEFAULT NULL,
  start_clock TIME DEFAULT NULL,
  end_clock TIME DEFAULT NULL,
  preventive_types VARCHAR(255) NOT NULL,
  technician_name VARCHAR(150) DEFAULT NULL,
  draft_date DATETIME DEFAULT NULL,
  approved_by_engineering_date DATETIME DEFAULT NULL,
  approved_by_manager_date DATETIME DEFAULT NULL,
  approved_by_engineering_user VARCHAR(150) DEFAULT NULL,
  approved_by_manager_user VARCHAR(150) DEFAULT NULL,
  status ENUM('Draft', 'Approved by Engineering', 'Approved by Manager') DEFAULT 'Draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_preventive_machine
    FOREIGN KEY (machine_no) REFERENCES machines(no)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS maintenance_orders (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  machine_no INT NOT NULL,
  machine_asset VARCHAR(100) NOT NULL,
  machine_name VARCHAR(255) NOT NULL,
  location VARCHAR(255) DEFAULT NULL,
  department VARCHAR(100) DEFAULT NULL,
  sub ENUM('MTC', 'UTY', 'BLD') NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL,
  week INT NOT NULL,
  preventive_types VARCHAR(255) NOT NULL,
  preventive_date DATE DEFAULT NULL,
  execution_date DATE DEFAULT NULL,
  start_clock TIME DEFAULT NULL,
  end_clock TIME DEFAULT NULL,
  technician_name VARCHAR(150) DEFAULT NULL,
  status ENUM('In Progress', 'Approval', 'Completed') NOT NULL,
  approved_by_manager_date DATETIME DEFAULT NULL,
  approved_by_manager_user VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_machine
    FOREIGN KEY (machine_no) REFERENCES machines(no)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS preventive_types (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  abbreviation VARCHAR(50) NOT NULL UNIQUE,
  parameter VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS machine_parameters (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  machine_no INT NOT NULL,
  part_master VARCHAR(255) NOT NULL,
  part_checklist VARCHAR(255) NOT NULL,
  action TEXT,
  standard TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_parameter_machine
    FOREIGN KEY (machine_no) REFERENCES machines(no)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS order_checklist_results (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  parameter_id BIGINT NOT NULL,
  result VARCHAR(255) DEFAULT NULL,
  justification VARCHAR(255) DEFAULT 'NA',
  part_master VARCHAR(255) DEFAULT NULL,
  part_checklist VARCHAR(255) DEFAULT NULL,
  action TEXT,
  standard TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_order_param (order_id, parameter_id),
  KEY idx_order (order_id),
  KEY idx_parameter (parameter_id),
  CONSTRAINT fk_result_order
    FOREIGN KEY (order_id) REFERENCES maintenance_orders(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_result_parameter
    FOREIGN KEY (parameter_id) REFERENCES machine_parameters(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

-- Example insert for machine data from CSV import, mapped to your column names:
-- INSERT INTO machines (no, kode_mesin, nama_mesin, lokasi, departemen, kategori)
-- VALUES
-- (1, 'MTC-001', 'CNC Machine A', 'Workshop A', 'EG1', 'MTC');
