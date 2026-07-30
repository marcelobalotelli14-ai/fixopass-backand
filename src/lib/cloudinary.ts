import { v2 as cloudinary } from 'cloudinary';

// Lê automaticamente a variável de ambiente CLOUDINARY_URL
// (formato cloudinary://<api_key>:<api_secret>@<cloud_name>), que deve
// ser configurada nas variáveis de ambiente do Railway.
cloudinary.config({ secure: true });

export { cloudinary };
