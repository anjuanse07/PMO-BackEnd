// MySQL DATETIME columns reject ISO strings like '...T...Z'; normalize to 'YYYY-MM-DD HH:MM:SS'
function toMySQLDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toMySQLDate(value) {
  if (!value) return null;
  const text = String(value);
  const datePart = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePart) return datePart[1];

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

module.exports = { toMySQLDateTime, toMySQLDate };
