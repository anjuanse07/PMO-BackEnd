const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Each router below already declares its full '/api/...' paths, so mount
// at '/' - not '/api' - or every route would double up to '/api/api/...'.
app.use(require('./routes/health'));
app.use(require('./routes/audit'));
app.use(require('./routes/history'));
app.use(require('./routes/machines'));
app.use(require('./routes/schedules'));
app.use(require('./routes/orders'));
app.use(require('./routes/auth'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
