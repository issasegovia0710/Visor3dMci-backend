require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const XLSX = require("xlsx");
const mime = require("mime");
const { createClient } = require("@supabase/supabase-js");

/* ============================
   Config Supabase
============================ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_MODELS_BUCKET =
  process.env.SUPABASE_MODELS_BUCKET || "models";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "ERROR: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están definidos en .env"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ============================
   Helpers
============================ */

function slugify(str) {
  return (
    (str || "proyecto")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 40) || "proyecto"
  );
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

/**
 * Convierte un row de la tabla projects al formato que usas en el front.
 */
function projectRowToView(row) {
  if (!row) return null;

  // URL pública del modelo, si hay ruta
  let modelUrl = null;
  if (row.model_path) {
    const { data } = supabase.storage
      .from(SUPABASE_MODELS_BUCKET)
      .getPublicUrl(row.model_path);
    modelUrl = data.publicUrl;
  }

  return {
    id: row.id,
    name: row.name,
    author: row.author || "",
    date: row.project_date || "",
    position: row.position || { x: 0, y: 0, z: 0 },
    rotation: row.rotation || { x: 0, y: 0, z: 0 },
    modelFile: row.model_filename || null,
    modelUrl,
    pendingNotes: row.pending_notes || "",
    partsMeta: row.parts_meta || {},
  };
}

/**
 * Construye un workbook de Excel en memoria a partir de una cotización.
 * (SIN columna de links)
 */
function buildQuoteWorkbook(quoteDoc) {
  const rows = (quoteDoc.items || []).map((it) => {
    const cantidad = Number(it.cantidad) || 0;
    const precio = Number(it.precio) || 0;
    return {
      Concepto: it.concepto,
      Cantidad: cantidad,
      Precio: precio,
      Importe: cantidad * precio,
    };
  });

  rows.push({});
  rows.push({
    Concepto: "TOTAL",
    Cantidad: "",
    Precio: "",
    Importe: Number(quoteDoc.total) || 0,
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, {
    header: ["Concepto", "Cantidad", "Precio", "Importe"],
  });
  XLSX.utils.book_append_sheet(wb, ws, "Cotización");
  return wb;
}

/* ============================
   Configuración básica Express
============================ */

const app = express();
const PORT = process.env.PORT || 4000;

/* ============================
   CORS: permite varios orígenes (local + producción)
============================ */

const rawOrigins = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "";
const allowedOrigins = rawOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      // Para peticiones tipo Postman, curl o mismo servidor (sin origin)
      if (!origin) {
        return callback(null, true);
      }

      // Si no configuraste nada, por seguridad se puede bloquear todo
      // o permitir todos. Aquí dejamos: si no hay lista, se permite todo.
      if (allowedOrigins.length === 0) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn("CORS bloqueó origen:", origin);
      return callback(new Error("Not allowed by CORS: " + origin));
    },
  })
);

app.use(express.json());

// Carpeta temporal para subidas
const uploadTmpDir = path.join(__dirname, "tmp_uploads");
if (!fs.existsSync(uploadTmpDir)) {
  fs.mkdirSync(uploadTmpDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadTmpDir);
  },
  filename: (req, file, cb) => {
    const safeName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safeName);
  },
});

const upload = multer({ storage });

/* ============================
   Rutas de proyectos
============================ */

/**
 * POST /api/projects
 * Crea un proyecto nuevo y sube el modelo 3D a Supabase Storage.
 */
app.post("/api/projects", upload.single("model"), async (req, res) => {
  try {
    const { projectName, author, date, password, position, rotation } =
      req.body;

    if (!projectName || !password || !req.file) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({
        ok: false,
        error: "projectName, password y model son obligatorios.",
      });
    }

    const folderSlug = slugify(projectName);

    // parse position / rotation
    let positionObj = { x: 0, y: 0, z: 0 };
    let rotationObj = { x: 0, y: 0, z: 0 };
    try {
      if (position) positionObj = JSON.parse(position);
    } catch (e) {
      console.warn("position no es JSON válido, se usa por defecto.");
    }
    try {
      if (rotation) rotationObj = JSON.parse(rotation);
    } catch (e) {
      console.warn("rotation no es JSON válido, se usa por defecto.");
    }

    // Subir modelo a Supabase Storage
    const ext = path.extname(req.file.originalname) || "";
    const modelFileName = "modelo" + ext;
    const objectPath = `${folderSlug}/${modelFileName}`;
    const fileBuffer = fs.readFileSync(req.file.path);
    const contentType =
      req.file.mimetype || mime.getType(ext) || "application/octet-stream";

    const { error: uploadError } = await supabase.storage
      .from(SUPABASE_MODELS_BUCKET)
      .upload(objectPath, fileBuffer, {
        upsert: true,
        contentType,
      });

    fs.unlinkSync(req.file.path);

    if (uploadError) {
      console.error("Error subiendo modelo a Supabase:", uploadError);
      return res
        .status(500)
        .json({ ok: false, error: "Error al subir el modelo." });
    }

    const passwordHash = hashPassword(password);

    const { data: inserted, error: insertError } = await supabase
      .from("projects")
      .insert([
        {
          id: folderSlug,
          name: projectName,
          author: author || "",
          project_date: date || new Date().toISOString().slice(0, 10),
          password_hash: passwordHash,
          position: positionObj,
          rotation: rotationObj,
          model_path: objectPath,
          model_filename: modelFileName,
          pending_notes: "",
          parts_meta: {},
        },
      ])
      .select()
      .single();

    if (insertError) {
      console.error("Error insertando proyecto:", insertError);
      return res
        .status(500)
        .json({ ok: false, error: "Error interno al crear el proyecto." });
    }

    const view = projectRowToView(inserted);

    return res.status(201).json({
      ok: true,
      message: "Proyecto creado.",
      projectId: inserted.id,
      project: view,
    });
  } catch (err) {
    console.error("Error en POST /api/projects:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Error interno del servidor." });
  }
});

/**
 * GET /api/projects
 * Lista todos los proyectos.
 */
app.get("/api/projects", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error listando projects:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const projects = (data || []).map(projectRowToView);
    return res.json({ ok: true, projects });
  } catch (err) {
    console.error("Error en GET /api/projects:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * Helper: obtener proyecto por id
 */
async function getProjectById(id) {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();
  if (error) {
    return { error };
  }
  return { data };
}

/**
 * GET /api/projects/:id
 */
app.get("/api/projects/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await getProjectById(id);

    if (error && error.code === "PGRST116") {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (error) {
      console.error("Error obteniendo proyecto:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const view = projectRowToView(data);
    return res.json({ ok: true, project: view });
  } catch (err) {
    console.error("Error en GET /api/projects/:id:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * PUT /api/projects/:id/transform
 * Actualiza posición y rotación.
 */
app.put("/api/projects/:id/transform", async (req, res) => {
  try {
    const { id } = req.params;
    const { password, position, rotation } = req.body || {};

    const { data: project, error } = await getProjectById(id);
    if (error && error.code === "PGRST116") {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (error) {
      console.error("Error obteniendo proyecto:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    if (password) {
      const hash = hashPassword(password);
      if (hash !== project.password_hash) {
        return res
          .status(403)
          .json({ ok: false, error: "Contraseña incorrecta." });
      }
    }

    const newPosition = position || project.position || { x: 0, y: 0, z: 0 };
    const newRotation = rotation || project.rotation || { x: 0, y: 0, z: 0 };

    const { data: updated, error: updateError } = await supabase
      .from("projects")
      .update({
        position: newPosition,
        rotation: newRotation,
      })
      .eq("id", id)
      .select()
      .single();

    if (updateError) {
      console.error("Error actualizando transform:", updateError);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const view = projectRowToView(updated);
    return res.json({ ok: true, project: view });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/transform:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * PUT /api/projects/:id/model
 * Reemplaza el modelo 3D en Supabase Storage.
 */
app.put("/api/projects/:id/model", upload.single("model"), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res
        .status(400)
        .json({ ok: false, error: "Archivo de modelo requerido." });
    }

    const { data: project, error } = await getProjectById(id);
    if (error && error.code === "PGRST116") {
      fs.unlinkSync(req.file.path);
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (error) {
      fs.unlinkSync(req.file.path);
      console.error("Error obteniendo proyecto:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    // Borrar modelo anterior si existe
    if (project.model_path) {
      await supabase.storage
        .from(SUPABASE_MODELS_BUCKET)
        .remove([project.model_path]);
    }

    // Subir nuevo modelo
    const ext = path.extname(req.file.originalname) || "";
    const modelFileName = "modelo" + ext;
    const objectPath = `${id}/${modelFileName}`;
    const fileBuffer = fs.readFileSync(req.file.path);
    const contentType =
      req.file.mimetype || mime.getType(ext) || "application/octet-stream";

    const { error: uploadError } = await supabase.storage
      .from(SUPABASE_MODELS_BUCKET)
      .upload(objectPath, fileBuffer, {
        upsert: true,
        contentType,
      });

    fs.unlinkSync(req.file.path);

    if (uploadError) {
      console.error("Error subiendo modelo:", uploadError);
      return res
        .status(500)
        .json({ ok: false, error: "Error al subir el modelo." });
    }

    const { data: updated, error: updateError } = await supabase
      .from("projects")
      .update({
        model_path: objectPath,
        model_filename: modelFileName,
      })
      .eq("id", id)
      .select()
      .single();

    if (updateError) {
      console.error("Error guardando ruta de modelo:", updateError);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const view = projectRowToView(updated);
    return res.json({
      ok: true,
      message: "Modelo reemplazado.",
      project: view,
    });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/model:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * PUT /api/projects/:id/rename
 */
app.put("/api/projects/:id/rename", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, password } = req.body || {};

    if (!name || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "name y password son obligatorios." });
    }

    const { data: project, error } = await getProjectById(id);
    if (error && error.code === "PGRST116") {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (error) {
      console.error("Error obteniendo proyecto:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const hash = hashPassword(password);
    if (hash !== project.password_hash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const { data: updated, error: updateError } = await supabase
      .from("projects")
      .update({ name })
      .eq("id", id)
      .select()
      .single();

    if (updateError) {
      console.error("Error renombrando proyecto:", updateError);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const view = projectRowToView(updated);
    return res.json({
      ok: true,
      message: "Proyecto renombrado.",
      project: view,
    });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/rename:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * PUT /api/projects/:id/notes
 */
app.put("/api/projects/:id/notes", async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, password } = req.body || {};

    if (typeof notes !== "string" || !password) {
      return res.status(400).json({
        ok: false,
        error: "notes (string) y password son obligatorios.",
      });
    }

    const { data: project, error } = await getProjectById(id);
    if (error && error.code === "PGRST116") {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (error) {
      console.error("Error obteniendo proyecto:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const hash = hashPassword(password);
    if (hash !== project.password_hash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const { data: updated, error: updateError } = await supabase
      .from("projects")
      .update({ pending_notes: notes })
      .eq("id", id)
      .select()
      .single();

    if (updateError) {
      console.error("Error guardando notas:", updateError);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const view = projectRowToView(updated);
    return res.json({
      ok: true,
      message: "Notas guardadas.",
      project: view,
    });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/notes:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * PUT /api/projects/:id/parts-meta
 */
app.put("/api/projects/:id/parts-meta", async (req, res) => {
  try {
    const { id } = req.params;
    const { partId, name, notes, color, materialPreset, password } =
      req.body || {};

    if (partId === undefined || !password) {
      return res.status(400).json({
        ok: false,
        error: "partId y password son obligatorios.",
      });
    }

    const { data: project, error } = await getProjectById(id);
    if (error && error.code === "PGRST116") {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (error) {
      console.error("Error obteniendo proyecto:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const hash = hashPassword(password);
    if (hash !== project.password_hash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const currentMeta = project.parts_meta || {};
    const key = String(partId);
    const oldMeta = currentMeta[key] || {};

    currentMeta[key] = {
      name: name !== undefined ? name : oldMeta.name || "",
      notes: notes !== undefined ? notes : oldMeta.notes || "",
      color: color !== undefined ? color : oldMeta.color || "#22c55e",
      materialPreset:
        materialPreset !== undefined
          ? materialPreset
          : oldMeta.materialPreset || "plastic",
    };

    const { data: updated, error: updateError } = await supabase
      .from("projects")
      .update({ parts_meta: currentMeta })
      .eq("id", id)
      .select()
      .single();

    if (updateError) {
      console.error("Error guardando parts-meta:", updateError);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const view = projectRowToView(updated);
    return res.json({
      ok: true,
      message: "Metadatos de pieza guardados.",
      project: view,
    });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/parts-meta:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * DELETE /api/projects/:id
 */
app.delete("/api/projects/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body || {};

    if (!password) {
      return res
        .status(400)
        .json({ ok: false, error: "Contraseña requerida." });
    }

    const { data: project, error } = await getProjectById(id);
    if (error && error.code === "PGRST116") {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (error) {
      console.error("Error obteniendo proyecto:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const hash = hashPassword(password);
    if (hash !== project.password_hash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    // Borrar modelo en storage si existe
    if (project.model_path) {
      await supabase.storage
        .from(SUPABASE_MODELS_BUCKET)
        .remove([project.model_path]);
    }

    const { error: delError } = await supabase
      .from("projects")
      .delete()
      .eq("id", id);

    if (delError) {
      console.error("Error eliminando proyecto:", delError);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    return res.json({ ok: true, message: "Proyecto eliminado." });
  } catch (err) {
    console.error("Error en DELETE /api/projects/:id:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   COTIZACIONES: /api/quotes/:id
============================ */

/**
 * GET /api/quotes/:id
 * Obtiene la cotización de un proyecto (si existe).
 */
app.get("/api/quotes/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("quotes")
      .select("*")
      .eq("project_id", id)
      .single();

    if (error && error.code === "PGRST116") {
      return res.status(404).json({
        ok: false,
        error: "No hay cotización guardada para este proyecto.",
      });
    }
    if (error) {
      console.error("Error obteniendo cotización:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    return res.json({
      ok: true,
      quote: {
        projectId: data.project_id,
        items: data.items || [],
        total: data.total || 0,
      },
    });
  } catch (err) {
    console.error("Error en GET /api/quotes/:id:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * PUT /api/quotes/:id
 * Guarda / actualiza la cotización de un proyecto.
 */
app.put("/api/quotes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { password, items, total } = req.body || {};

    if (!password || !Array.isArray(items)) {
      return res.status(400).json({
        ok: false,
        error: "password e items (array) son obligatorios.",
      });
    }

    const { data: project, error } = await getProjectById(id);
    if (error && error.code === "PGRST116") {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (error) {
      console.error("Error obteniendo proyecto:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const hash = hashPassword(password);
    if (hash !== project.password_hash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const normalizedItems = items.map((it) => ({
      concepto: (it.concepto || "").toString(),
      cantidad: Number(it.cantidad) || 0,
      precio: Number(it.precio) || 0,
      link: (it.link || "").toString(),
    }));

    let computedTotal = normalizedItems.reduce(
      (acc, it) => acc + it.cantidad * it.precio,
      0
    );
    if (!isFinite(computedTotal)) computedTotal = 0;

    const finalTotal =
      typeof total === "number" && isFinite(total) ? total : computedTotal;

    const { data: upserted, error: upsertError } = await supabase
      .from("quotes")
      .upsert(
        {
          project_id: id,
          items: normalizedItems,
          total: finalTotal,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id" }
      )
      .select()
      .single();

    if (upsertError) {
      console.error("Error guardando cotización:", upsertError);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    return res.json({
      ok: true,
      message: "Cotización guardada.",
      quote: {
        projectId: upserted.project_id,
        items: upserted.items || [],
        total: upserted.total || 0,
      },
    });
  } catch (err) {
    console.error("Error en PUT /api/quotes/:id:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/**
 * GET /api/quotes/:id/excel
 * Genera el Excel en memoria y lo descarga.
 */
app.get("/api/quotes/:id/excel", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("quotes")
      .select("*")
      .eq("project_id", id)
      .single();

    if (error && error.code === "PGRST116") {
      return res.status(404).json({
        ok: false,
        error:
          "No hay cotización guardada. Primero guarda la cotización para poder descargar el Excel.",
      });
    }
    if (error) {
      console.error("Error obteniendo cotización para Excel:", error);
      return res.status(500).json({ ok: false, error: "Error interno." });
    }

    const quoteDoc = {
      projectId: data.project_id,
      items: data.items || [],
      total: data.total || 0,
    };

    const wb = buildQuoteWorkbook(quoteDoc);
    const buffer = XLSX.write(wb, {
      bookType: "xlsx",
      type: "buffer",
    });

    const fileName = `cotizacion-${id}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    return res.send(buffer);
  } catch (err) {
    console.error("Error en GET /api/quotes/:id/excel:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   Arrancar servidor
============================ */

app.listen(PORT, () => {
  console.log(`API corriendo en puerto ${PORT}`);
});
