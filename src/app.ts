import 'dotenv/config';
import './lib/zodErrorMap';
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
import webhooksRouter from './routes/webhooks';
import adminRouter from './routes/admin';
import oauthRouter from './routes/oauth';
import { errorHandler } from './middleware/errorHandler';

// Extraído de index.ts para o app Express poder ser importado sem abrir
// uma porta de verdade — é o que permite os testes (ver src/__tests__)
// usarem supertest diretamente contra `app`, sem subir um processo HTTP
// separado. index.ts continua sendo o único lugar que chama `.listen()`.
export const app = express();
app.set('trust proxy', 1);

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
app.use('/webhooks', webhooksRouter);
app.use('/admin', adminRouter);
// Canal WEB/API — sistemas externos (ex.: cardápio online) usam essas
// rotas OAuth2 (authorization_code) via client_id/client_secret pra
// iniciar e concluir um compartilhamento sem precisar do app/NFC/QR.
// Reaproveita o mesmo núcleo de usuário/empresa/consentimento dos demais
// canais — ver src/lib/compartilhamento.ts.
app.use('/oauth', oauthRouter);

// Precisa ser o último app.use(): captura qualquer erro repassado por
// asyncHandler ou por middlewares síncronos, em qualquer rota acima.
app.use(errorHandler);
