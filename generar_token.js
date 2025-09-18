const jwt = require('jsonwebtoken');

// Reemplaza esto con tu clave secreta real
const JWT_SECRET = 'mi-super-secreto-jwt-2024'; 

// Define el payload (información del usuario)
const payload = {
  usuarioId: 1
};

// Genera el token con una expiración (opcional)
const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });

console.log(token);