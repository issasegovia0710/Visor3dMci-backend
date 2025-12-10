# Visor 3D Backend

Servidor Express para manejar proyectos 3D (subida de modelos, escenas y metadatos).

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
npm install
```

## Ejecución en local

```bash
npm start
```

Por defecto escucha en el puerto `4000` (o el que pongas en la variable `PORT`).

## Variables de entorno

- `PORT`: puerto donde escuchará el servidor (opcional, por defecto 4000)
- `CORS_ORIGIN`: origen permitido para CORS (por ejemplo `https://visor3dmci.netlify.app`).
  Si no se define, acepta todos los orígenes (`*`).

## Estructura de carpetas

- `public/` : aquí se crean las carpetas por proyecto y se guarda `modelo.ext` y `scene.json`.
- `tmp_uploads/` : carpeta temporal para subidas de archivos.
