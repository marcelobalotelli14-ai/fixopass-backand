import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';

import authRouter from './routes/auth';
import customerRouter from './routes/customer';
import usersRouter from './routes/users';
import companiesRouter from './routes/companies';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// Documentação interativa da API em /docs
const openapiDocument = YAML.load(path.join(__dirname, '..', 'openapi.yaml'));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRouter);
app.use('/customer', customerRouter);
app.use('/users', usersRouter);
app.use('/companies', companiesRouter);

// Precisa ser o último app.use(): captura qualquer erro repassado por
// asyncHandler ou por middlewares síncronos, em qualquer rota acima.
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FIXO PASS API rodando em http://localhost:${PORT}`);
  console.log(`Documentação Swagger em http://localhost:${PORT}/docs`);
});
