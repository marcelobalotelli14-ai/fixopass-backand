import multer from 'multer';

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const TIPOS_PERMITIDOS = ['image/png', 'image/jpeg', 'image/webp'];

export class TipoArquivoInvalidoError extends Error {}

/**
 * Guarda o arquivo em memória (buffer) em vez de disco — ele é repassado
 * direto para o Cloudinary via upload_stream, sem nunca tocar o filesystem
 * do contêiner (que no Railway é efêmero).
 */
export const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.includes(file.mimetype)) {
      return cb(new TipoArquivoInvalidoError('Formato de imagem não suportado. Envie PNG, JPEG ou WEBP.'));
    }
    cb(null, true);
  },
});

// Mesma config de uploadLogo (tamanho/tipos aceitos) — só um nome mais claro
// pro caso de uso em POST /users/me/foto (foto de perfil do usuário comum).
export const uploadFoto = uploadLogo;
