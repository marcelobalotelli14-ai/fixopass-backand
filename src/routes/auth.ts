import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { identifyActor } from '../middleware/identifyActor';
import { dispararPush } from '../lib/pushNotification';
import { asyncHandler } from '../lib/asyncHandler';

const router = Router();

const CAMPOS = ['NOME', 'TELEFONE', 'EMAIL', 'CPF', 'RG', 'DATA_NASCIMENTO', 'ENDERECO', 'FOTO'] as const;

// Corpo aceito quando quem chama é o APP DO USUÁRIO (leu QR ou aproximou NFC)
const userInitiatedSchema = z.object({
  metodo: z.enum(['NFC', 'QRCODE']),
  qrCodeToken: z.string().optional(), // vem da leitura do QR Code
  companyId: z.string().uuid().optional(), // vem da leitura do NFC (tag grava o id da empresa)
  unidadeId: z.string().uuid().optional(), // opcional, se o NFC também identificar a unidade
});

// Corpo aceito quando quem chama é o ERP/PAINEL DA EMPRESA (ex.: recepção digitando CPF)
const companyInitiatedSchema = z.object({
  metodo: z.enum(['NFC', 'QRCODE']),
  unidadeId: z.string().uuid().optional(),
  identificador: z.object({
    cpf: z.string().optional(),
    telefone: z.string().optional(),
  }),
  // Opcional: se a empresa não enviar, usamos os campos configurados em
  // "campos solicitados" (PUT /companies/me/campos-solicitados)
  camposPedidos: z.array(z.enum(CAMPOS)).optional(),
});

/**
 * POST /auth/request
 *
 * Fluxo 1 (app do usuário lê QR/NFC): autentica com X-USER-ID, informa
 * qrCodeToken OU companyId+unidadeId. Os campos pedidos são sempre os que a
 * PRÓPRIA EMPRESA configurou em campos-solicitados — o app não escolhe isso.
 *
 * Fluxo 2 (ERP/painel da empresa, ex.: terminal de recepção): autentica com
 * X-API-KEY, informa o CPF/telefone do cliente. camposPedidos é opcional;
 * se omitido, também usamos a configuração padrão da empresa.
 */
router.post(
  '/request',
  identifyActor,
  asyncHandler(async (req, res) => {
    const actor = req.actor!;

    if (actor.type === 'user') {
      const parsed = userInitiatedSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
      }
      const { metodo, qrCodeToken, companyId, unidadeId } = parsed.data;

      let resolvedCompanyId = companyId;
      let resolvedUnidadeId: string | undefined;

      if (qrCodeToken) {
        const unidade = await prisma.unidade.findUnique({ where: { qrCodeToken } });
        if (!unidade) {
          return res.status(404).json({ error: 'QR Code inválido ou expirado.' });
        }
        resolvedCompanyId = unidade.companyId;
        resolvedUnidadeId = unidade.id;
      } else if (unidadeId && resolvedCompanyId) {
        // NFC pode informar unidadeId direto (sem qrCodeToken) — confirmamos
        // que essa unidade realmente pertence à empresa informada, senão um
        // valor incorreto ficaria gravado sem nenhuma checagem.
        const unidade = await prisma.unidade.findUnique({ where: { id: unidadeId } });
        if (!unidade || unidade.companyId !== resolvedCompanyId) {
          return res.status(400).json({ error: 'unidadeId não pertence à empresa informada.' });
        }
        resolvedUnidadeId = unidade.id;
      }

      if (!resolvedCompanyId) {
        return res.status(400).json({ error: 'Informe qrCodeToken (QR) ou companyId (NFC).' });
      }

      const company = await prisma.company.findUnique({ where: { id: resolvedCompanyId } });
      if (!company || !company.ativa) {
        // Mesma mensagem de "não encontrada" pra QR/NFC de empresa encerrada —
        // não faz sentido diferenciar pro cliente que só está aproximando o
        // celular. É assim que "desativar as tags NFC/QR Code" se traduz na
        // prática: sem precisar mexer em cada Unidade, a checagem aqui já
        // barra qualquer leitura assim que a empresa dona delas é encerrada.
        return res.status(404).json({ error: 'QR Code inválido ou expirado.' });
      }

      const camposPedidos = await buscarCamposConfigurados(resolvedCompanyId);

      const solicitacao = await prisma.solicitacaoCompartilhamento.create({
        data: {
          userId: actor.id,
          companyId: resolvedCompanyId,
          unidadeId: resolvedUnidadeId,
          metodo,
          camposPedidos,
          status: 'PENDENTE',
        },
      });

      return res.status(201).json({
        solicitacaoId: solicitacao.id,
        status: solicitacao.status,
        empresa: company.nome,
        camposPedidos,
        mensagem: `A empresa ${company.nome} solicita acesso aos seus dados.`,
      });
    }

    // actor.type === 'company'
    const parsed = companyInitiatedSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos.', detalhes: parsed.error.flatten() });
    }
    const { identificador, unidadeId, metodo, camposPedidos } = parsed.data;
    const companyId = actor.id;

    if (unidadeId) {
      // Mesma checagem do outro fluxo: a unidade tem que ser da própria
      // empresa autenticada, senão o registro fica com dado cruzado.
      const unidade = await prisma.unidade.findUnique({ where: { id: unidadeId } });
      if (!unidade || unidade.companyId !== companyId) {
        return res.status(400).json({ error: 'unidadeId não pertence à sua empresa.' });
      }
    }

    let user = null;
    if (identificador.cpf) {
      user = await prisma.user.findUnique({ where: { cpf: identificador.cpf } });
    } else if (identificador.telefone) {
      user = await prisma.user.findFirst({ where: { telefone: identificador.telefone } });
    }

    if (!user) {
      return res.status(404).json({ error: 'Usuário FIXO PASS não encontrado.' });
    }

    const camposFinal = camposPedidos && camposPedidos.length > 0 ? camposPedidos : await buscarCamposConfigurados(companyId);

    const solicitacao = await prisma.solicitacaoCompartilhamento.create({
      data: {
        userId: user.id,
        companyId,
        unidadeId,
        metodo,
        camposPedidos: camposFinal,
        status: 'PENDENTE',
      },
    });

    // Avisa o usuário no celular — nesse fluxo (ERP/terminal identificando por
    // CPF) o usuário não está com o app aberto escaneando nada, então sem
    // push ele não teria como saber que precisa aprovar.
    if (user.expoPushToken) {
      dispararPush(user.expoPushToken, 'FIXO PASS', `${actor.nome} solicita acesso aos seus dados.`, {
        solicitacaoId: solicitacao.id,
      });
    }

    return res.status(201).json({
      solicitacaoId: solicitacao.id,
      status: solicitacao.status,
      mensagem: `A empresa ${actor.nome} solicita acesso aos seus dados.`,
    });
  })
);

/**
 * Busca os campos que a empresa configurou como necessários
 * (PUT /companies/me/campos-solicitados). Se a empresa ainda não configurou
 * nada, cai de volta para NOME + TELEFONE como padrão mínimo seguro.
 */
async function buscarCamposConfigurados(companyId: string): Promise<(typeof CAMPOS)[number][]> {
  const configurados = await prisma.campoSolicitadoEmpresa.findMany({ where: { companyId } });
  if (configurados.length === 0) return ['NOME', 'TELEFONE'];
  return configurados.map((c) => c.campo);
}

/**
 * GET /auth/request/:id
 * Alternativa ao webhook: o ERP consulta o status de uma solicitação que
 * ele mesmo criou (ou que o app do usuário criou apontando pra essa empresa).
 * Útil quando o ERP não tem como expor uma URL pública de webhook.
 */
router.get(
  '/request/:id',
  identifyActor,
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const solicitacao = await prisma.solicitacaoCompartilhamento.findUnique({
      where: { id: req.params.id },
      include: { company: { select: { nome: true } } },
    });

    if (!solicitacao) {
      return res.status(404).json({ error: 'Solicitação não encontrada.' });
    }

    const pertenceAoAtor =
      (actor.type === 'company' && solicitacao.companyId === actor.id) ||
      (actor.type === 'user' && solicitacao.userId === actor.id);

    if (!pertenceAoAtor) {
      return res.status(403).json({ error: 'Sem permissão para consultar esta solicitação.' });
    }

    return res.status(200).json({
      solicitacaoId: solicitacao.id,
      status: solicitacao.status,
      criadaEm: solicitacao.criadaEm,
      resolvidaEm: solicitacao.resolvidaEm,
      empresa: solicitacao.company.nome,
      camposPedidos: solicitacao.camposPedidos,
      mensagem: `A empresa ${solicitacao.company.nome} solicita acesso aos seus dados.`,
    });
  })
);

export default router;
