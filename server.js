const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
// Default express.json() limit is only 100kb, which is too small for bulk
// CSV imports (machine parameters, history log) that get parsed client-side
// and sent up as one big JSON array in a single request. 10mb gives
// generous headroom for large imports without being unreasonably permissive.
app.use(express.json({ limit: '10mb' }));

// Each router below already declares its full '/api/...' paths, so mount
// at '/' - not '/api' - or every route would double up to '/api/api/...'.
app.use(require('./routes/health'));
app.use(require('./routes/status'));
app.use(require('./routes/audit'));
app.use(require('./routes/history'));
app.use(require('./routes/machines'));
app.use(require('./routes/schedules'));
app.use(require('./routes/orders'));
app.use(require('./routes/auth'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
