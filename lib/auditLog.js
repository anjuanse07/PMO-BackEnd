const pool = require('./db');

// Roles allowed to view Audit Logs / History Log. Kept as one list so both
// pages (and their exports/imports) stay in sync if the allowed roles ever change.
const LOG_VIEWER_ROLES = ['manager', 'engineering supervisor'];
function isLogViewerRole(role) {
  return LOG_VIEWER_ROLES.includes(String(role || '').toLowerCase());
}

async function logAuditEvent(req, {
  userId = null,
  eventType,
  entityType = null,
  entityId = null,
  pagePath = null,
  actionLabel = null,
  metadata = null,
}) {
  try {
    const effectiveUserId = userId || Number(req.get('x-audit-user-id')) || null;
    await pool.query(
      `INSERT INTO audit_logs
       (user_id, session_id, event_type, entity_type, entity_id, page_path, action_label, metadata, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        effectiveUserId,
        req.get('x-audit-session-id') || null,
        eventType,
        entityType,
        entityId === null ? null : String(entityId),
        pagePath,
        actionLabel,
        metadata ? JSON.stringify(metadata) : null,
        req.ip || null,
        req.get('user-agent') || null,
      ],
    );
  } catch (error) {
    console.error('Write audit log failed:', error);
  }
}

// Turns a raw audit_logs row (event_type + metadata JSON) into the same kind
// of human-readable sentence the frontend builds for the Description column,
// so the CSV export reads the same way the table does.
//
// machinesByNo (optional): Map<machines.no, {nama_mesin, kode_mesin}>. When
// provided, "machine #<internal id>" is resolved to "<Name> (<Asset Code>)"
// instead of showing the raw internal machines.no, which is meaningless to
// anyone reading the notification/log.
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function machineLabel(machineNo, machinesByNo) {
  const machine = machineNo != null ? machinesByNo?.get(Number(machineNo)) : null;
  if (machine) return `${machine.nama_mesin} (${machine.kode_mesin})`;
  return machineNo != null ? `#${machineNo}` : '#-';
}

function describeAuditEvent(row, machinesByNo = new Map()) {
  // metadata is stored via JSON.stringify() into a LONGTEXT column (MariaDB's
  // "JSON" type has no true JSON wire type), so mysql2 always returns it as a
  // plain string here, never a pre-parsed object - it must be parsed back.
  let meta = row.metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = {};
    }
  }
  if (!meta || typeof meta !== 'object') meta = {};
  const list = (value) => (Array.isArray(value) && value.length ? value.join(', ') : null);

  switch (row.event_type) {
    case 'LOGIN': return 'Signed in to the application';
    case 'LOGOUT': return 'Signed out of the application';
    case 'PAGE_VIEW': return `Viewed ${row.page_path || 'a page'}`;
    case 'AUDIT_LOG_EXPORT': return `Exported audit logs (${String(meta.format || 'csv').toUpperCase()})`;
    case 'HISTORY_LOG_EXPORT': return 'Exported the history log (CSV)';
    case 'HISTORY_LOG_IMPORTED':
      return `Imported ${meta.inserted ?? 0} history log record(s)${meta.skipped ? `, skipped ${meta.skipped}` : ''}`;
    case 'MACHINE_PARAMETER_CREATED': return `Added a parameter to machine ${machineLabel(meta.machineNo ?? row.entity_id, machinesByNo)}`;
    case 'MACHINE_PARAMETERS_IMPORTED': return `Imported ${meta.inserted ?? 0} machine parameter(s)`;
    case 'MACHINE_PARAMETER_UPDATED': {
      const changes = meta.changes && typeof meta.changes === 'object' ? meta.changes : {};
      const changeKeys = Object.keys(changes);
      // Rows logged before this description was added only recorded which
      // field names changed, not the values or which machine/item - fall
      // back to that for old rows instead of showing a useless "for #-".
      if (!changeKeys.length && Array.isArray(meta.fields)) {
        return `Updated parameter fields: ${list(meta.fields) || '-'}`;
      }
      const label = machineLabel(meta.machineNo, machinesByNo);
      const itemName = meta.partChecklist || meta.partMaster || 'a checklist item';
      const fieldLabels = { part_master: 'Part Master', part_checklist: 'Checklist', action: 'Action', standard: 'Standard' };
      const changeParts = changeKeys.map((field) => {
        const change = changes[field];
        const from = change?.from ? `"${change.from}"` : '(empty)';
        const to = change?.to ? `"${change.to}"` : '(empty)';
        return `${fieldLabels[field] || field}: ${from} -> ${to}`;
      });
      return changeParts.length
        ? `Updated checklist item "${itemName}" for ${label} - ${changeParts.join('; ')}`
        : `Updated checklist item "${itemName}" for ${label}`;
    }
    case 'MACHINE_PARAMETER_DELETED': return 'Deleted a machine parameter';
    case 'SCHEDULE_PLAN_CREATED':
      return `Scheduled ${machineLabel(meta.machineNo, machinesByNo)} for ${meta.month != null ? MONTH_NAMES[meta.month] : '-'} ${meta.year ?? ''} (week ${meta.week ?? '-'})`;
    case 'SCHEDULE_PLAN_DELETED': return 'Deleted a schedule plan';
    case 'SCHEDULE_APPROVED_ENGINEERING': return 'Approved a schedule (Engineering stage)';
    case 'SCHEDULE_APPROVED_MANAGER': return 'Approved a schedule (Manager stage)';
    case 'MAINTENANCE_ORDER_CREATED': return `Created a preventive order for ${machineLabel(meta.machineNo, machinesByNo)} (status: ${meta.status ?? '-'})`;
    case 'MAINTENANCE_ORDER_UPDATED': return `Updated order fields: ${list(meta.fields) || '-'}`;
    case 'ORDER_CHECKLIST_SAVED': return `Saved checklist (${meta.itemsUpdated ?? 0} item(s) updated)`;
    case 'USER_PROFILE_UPDATED': return `Updated profile fields: ${list(meta.fields) || '-'}`;
    default:
      return row.action_label || row.event_type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  }
}

module.exports = { isLogViewerRole, logAuditEvent, describeAuditEvent, LOG_VIEWER_ROLES };
