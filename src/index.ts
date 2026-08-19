import { app } from './app';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FIXO PASS API rodando em http://localhost:${PORT}`);
  console.log(`Documentação Swagger em http://localhost:${PORT}/docs`);
});
