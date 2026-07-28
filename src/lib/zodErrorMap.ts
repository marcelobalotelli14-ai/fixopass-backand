import { z, ZodIssueCode } from 'zod';

/**
 * Por padrão o Zod gera mensagens de erro em inglês (ex.: "Invalid email",
 * "String must contain at least 6 character(s)"). Como essas mensagens vazam
 * direto pra resposta da API em `detalhes` (ver `parsed.error.flatten()` nas
 * rotas), definimos aqui um mapa global que traduz para português — assim
 * nenhuma rota precisa declarar mensagem customizada campo a campo.
 */
const errorMapPortugues: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') {
        return { message: 'Campo obrigatório.' };
      }
      return { message: `Tipo inválido: esperado ${issue.expected}, recebido ${issue.received}.` };

    case ZodIssueCode.invalid_literal:
      return { message: `Valor inválido, esperado ${JSON.stringify(issue.expected)}.` };

    case ZodIssueCode.unrecognized_keys:
      return { message: `Campo(s) não reconhecido(s): ${issue.keys.join(', ')}.` };

    case ZodIssueCode.invalid_union:
      return { message: 'Valor inválido.' };

    case ZodIssueCode.invalid_union_discriminator:
      return { message: `Valor inválido. Esperado um de: ${issue.options.map(String).join(', ')}.` };

    case ZodIssueCode.invalid_enum_value:
      return { message: `Valor inválido. Esperado um de: ${issue.options.join(', ')}.` };

    case ZodIssueCode.invalid_arguments:
      return { message: 'Argumentos inválidos.' };

    case ZodIssueCode.invalid_return_type:
      return { message: 'Tipo de retorno inválido.' };

    case ZodIssueCode.invalid_date:
      return { message: 'Data inválida.' };

    case ZodIssueCode.invalid_string: {
      const validation = issue.validation;
      if (validation === 'email') return { message: 'E-mail inválido.' };
      if (validation === 'url') return { message: 'URL inválida.' };
      if (validation === 'uuid') return { message: 'Identificador (UUID) inválido.' };
      if (validation === 'datetime') return { message: 'Data/hora inválida (formato ISO 8601 esperado).' };
      if (validation === 'regex') return { message: 'Formato inválido.' };
      if (validation === 'cuid') return { message: 'Identificador (CUID) inválido.' };
      if (typeof validation === 'object') {
        if ('startsWith' in validation) return { message: `Deve começar com "${validation.startsWith}".` };
        if ('endsWith' in validation) return { message: `Deve terminar com "${validation.endsWith}".` };
        if ('includes' in validation) return { message: `Deve conter "${validation.includes}".` };
      }
      return { message: 'Texto em formato inválido.' };
    }

    case ZodIssueCode.too_small: {
      const limite = issue.minimum.toString();
      if (issue.type === 'string') {
        return {
          message: issue.exact
            ? `Deve conter exatamente ${limite} caractere(s).`
            : `Deve conter no mínimo ${limite} caractere(s).`,
        };
      }
      if (issue.type === 'array') {
        return {
          message: issue.exact
            ? `Deve conter exatamente ${limite} item(ns).`
            : `Deve conter no mínimo ${limite} item(ns).`,
        };
      }
      if (issue.type === 'number' || issue.type === 'bigint') {
        return { message: `Deve ser maior ou igual a ${limite}.` };
      }
      if (issue.type === 'date') {
        return { message: `Data deve ser posterior ou igual a ${new Date(Number(limite)).toLocaleDateString('pt-BR')}.` };
      }
      return { message: 'Valor muito pequeno.' };
    }

    case ZodIssueCode.too_big: {
      const limite = issue.maximum.toString();
      if (issue.type === 'string') {
        return {
          message: issue.exact
            ? `Deve conter exatamente ${limite} caractere(s).`
            : `Deve conter no máximo ${limite} caractere(s).`,
        };
      }
      if (issue.type === 'array') {
        return {
          message: issue.exact
            ? `Deve conter exatamente ${limite} item(ns).`
            : `Deve conter no máximo ${limite} item(ns).`,
        };
      }
      if (issue.type === 'number' || issue.type === 'bigint') {
        return { message: `Deve ser menor ou igual a ${limite}.` };
      }
      if (issue.type === 'date') {
        return { message: `Data deve ser anterior ou igual a ${new Date(Number(limite)).toLocaleDateString('pt-BR')}.` };
      }
      return { message: 'Valor muito grande.' };
    }

    case ZodIssueCode.custom:
      return { message: ctx.defaultError };

    case ZodIssueCode.invalid_intersection_types:
      return { message: 'Não foi possível combinar os valores informados.' };

    case ZodIssueCode.not_multiple_of:
      return { message: `Deve ser múltiplo de ${issue.multipleOf}.` };

    case ZodIssueCode.not_finite:
      return { message: 'Deve ser um número finito.' };

    default:
      return { message: ctx.defaultError };
  }
};

z.setErrorMap(errorMapPortugues);
