const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors());
// Limit diperbesar ke 50mb agar upload gambar Base64 tidak ditolak oleh Express
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const ADMIN_PIN = "08111345";

// Koneksi ke Database MySQL (Nama database tetap db_preorder_makanan)
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'db_preorder_makanan'
});

// Auto-Migrasi Tabel otomatis menyesuaikan struktur tabel orders (qty, alamat, status)
async function ensureDatabaseSchema() {
  try {
    const [custCols] = await pool.query("SHOW COLUMNS FROM customers LIKE 'password'");
    if (custCols.length === 0) {
      await pool.query("ALTER TABLE customers ADD COLUMN password VARCHAR(255) NOT NULL DEFAULT ''");
    }

    const [roleCols] = await pool.query("SHOW COLUMNS FROM customers LIKE 'role'");
    if (roleCols.length === 0) {
      await pool.query("ALTER TABLE customers ADD COLUMN role VARCHAR(50) NOT NULL DEFAULT 'customer'");
    }

    const [menuImgCols] = await pool.query("SHOW COLUMNS FROM menus LIKE 'menu_images'");
    if (menuImgCols.length === 0) {
      const [oldImgCols] = await pool.query("SHOW COLUMNS FROM menus LIKE 'gambar_url'");
      if (oldImgCols.length > 0) {
        await pool.query("ALTER TABLE menus CHANGE COLUMN gambar_url menu_images LONGTEXT");
      } else {
        await pool.query("ALTER TABLE menus ADD COLUMN menu_images LONGTEXT");
      }
    } else {
      await pool.query("ALTER TABLE menus MODIFY COLUMN menu_images LONGTEXT");
    }

    // Pastikan kolom qty ada di tabel orders
    const [qtyCols] = await pool.query("SHOW COLUMNS FROM orders LIKE 'qty'");
    if (qtyCols.length === 0) {
      const [quantityCols] = await pool.query("SHOW COLUMNS FROM orders LIKE 'quantity'");
      if (quantityCols.length > 0) {
        await pool.query("ALTER TABLE orders CHANGE COLUMN quantity qty INT NOT NULL DEFAULT 1");
      } else {
        await pool.query("ALTER TABLE orders ADD COLUMN qty INT NOT NULL DEFAULT 1");
      }
    }

    // Pastikan kolom alamat di tabel orders bertipe TEXT (bukan INT yang membuat alamat jadi angka 0)
    const [alamatCols] = await pool.query("SHOW COLUMNS FROM orders LIKE 'alamat'");
    if (alamatCols.length > 0) {
      await pool.query("ALTER TABLE orders MODIFY COLUMN alamat TEXT");
    } else {
      const [alamatPengirimanCols] = await pool.query("SHOW COLUMNS FROM orders LIKE 'alamat_pengiriman'");
      if (alamatPengirimanCols.length > 0) {
        await pool.query("ALTER TABLE orders CHANGE COLUMN alamat_pengiriman alamat TEXT");
      } else {
        await pool.query("ALTER TABLE orders ADD COLUMN alamat TEXT");
      }
    }

    // Pastikan kolom status di tabel orders bertipe VARCHAR(50) dengan default 'Menunggu'
    const [statusCols] = await pool.query("SHOW COLUMNS FROM orders LIKE 'status'");
    if (statusCols.length > 0) {
      await pool.query("ALTER TABLE orders MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'Menunggu'");
    } else {
      await pool.query("ALTER TABLE orders ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'Menunggu'");
    }

    // Pastikan jika kolom status_pengiriman juga ada di tabel, tidak error saat INSERT
    const [statusPengirimanCols] = await pool.query("SHOW COLUMNS FROM orders LIKE 'status_pengiriman'");
    if (statusPengirimanCols.length > 0) {
      await pool.query("ALTER TABLE orders MODIFY COLUMN status_pengiriman VARCHAR(50) NOT NULL DEFAULT 'Menunggu'");
    }

    // Isi kolom status yang kosong pada data lama menjadi 'Menunggu'
    await pool.query(
      "UPDATE orders SET status = 'Menunggu' WHERE status IS NULL OR TRIM(status) = ''"
    );

    console.log("Skema database siap digunakan (menggunakan kolom: qty, alamat, status).");
  } catch (err) {
    console.error("Peringatan cek skema database:", err.message);
  }
}
ensureDatabaseSchema();

// 1A. Endpoint Daftar (Register) Pelanggan Baru
app.post('/api/register', async (req, res) => {
  try {
    const { nama, wa, password, alamat } = req.body;
    if (!nama || !wa || !password || !alamat) {
      return res.status(400).json({ error: 'Semua kolom pendaftaran wajib diisi!' });
    }

    const [existing] = await pool.query('SELECT * FROM customers WHERE no_whatsapp = ?', [wa]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Nomor WhatsApp sudah terdaftar! Silakan gunakan halaman Login.' });
    }

    const [result] = await pool.query(
      "INSERT INTO customers (nama, no_whatsapp, password, alamat, role) VALUES (?, ?, ?, ?, 'customer')",
      [nama, wa, password, alamat]
    );

    return res.json({
      id: result.insertId,
      nama,
      wa,
      no_whatsapp: wa,
      alamat,
      role: 'customer'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1B. Endpoint Login Pelanggan & Admin Terdaftar
app.post('/api/login', async (req, res) => {
  try {
    const { nama, wa, password } = req.body;
    if (!nama || !wa || !password) {
      return res.status(400).json({ error: 'Harap isi Nama, Nomor WhatsApp, dan Password!' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM customers WHERE LOWER(TRIM(nama)) = LOWER(TRIM(?)) AND TRIM(no_whatsapp) = TRIM(?) AND password = ?',
      [nama, wa, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Data Login tidak sesuai! Pastikan Nama, No. WhatsApp, dan Password benar.' });
    }

    const user = rows[0];
    return res.json({
      id: user.id,
      nama: user.nama,
      wa: user.no_whatsapp,
      no_whatsapp: user.no_whatsapp,
      alamat: user.alamat,
      role: user.role || 'customer'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Endpoint Ambil Semua Menu
app.get('/api/menus', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM menus ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Endpoint Tambah Menu Baru dari Admin
app.post('/api/menus', async (req, res) => {
  try {
    const { name, price, stock, status, image, description } = req.body;
    await pool.query(
      'INSERT INTO menus (nama_menu, harga, stok, status, menu_images, deskripsi) VALUES (?, ?, ?, ?, ?, ?)',
      [name, price, stock, status, image || '', description || '']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Endpoint Edit Menu dari Admin
app.put('/api/menus/:id', async (req, res) => {
  try {
    const { name, price, stock, status, image, description } = req.body;
    if (image) {
      await pool.query(
        'UPDATE menus SET nama_menu = ?, harga = ?, stok = ?, status = ?, menu_images = ?, deskripsi = ? WHERE id = ?',
        [name, price, stock, status, image, description || '', req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE menus SET nama_menu = ?, harga = ?, stok = ?, status = ?, deskripsi = ? WHERE id = ?',
        [name, price, stock, status, description || '', req.params.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Endpoint Hapus Menu dari Admin
app.delete('/api/menus/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM menus WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Endpoint Buat Pesanan Pre-Order Baru & Kurangi Stok Otomatis (Sesuai kolom: qty, alamat, status)
app.post('/api/orders', async (req, res) => {
  const { customer_id, menu_id, qty, address } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [menus] = await conn.query('SELECT * FROM menus WHERE id = ? FOR UPDATE', [menu_id]);
    if (menus.length === 0 || Number(menus[0].stok) < Number(qty)) {
      throw new Error('Stok menu tidak mencukupi!');
    }

    const total_harga = Number(menus[0].harga) * Number(qty);
    const kode_pesanan = 'PO-' + Date.now().toString().slice(-6);

    // Kurangi stok
    await conn.query('UPDATE menus SET stok = stok - ? WHERE id = ?', [qty, menu_id]);

    // Update alamat terbaru user di tabel customers
    await conn.query('UPDATE customers SET alamat = ? WHERE id = ?', [address, customer_id]);

    // Simpan pesanan ke tabel orders menggunakan nama kolom asli: qty, alamat, status
    await conn.query(
      `INSERT INTO orders (kode_pesanan, customer_id, menu_id, qty, total_harga, alamat, status)
       VALUES (?, ?, ?, ?, ?, ?, 'Menunggu')`,
      [kode_pesanan, customer_id, menu_id, qty, total_harga, address]
    );

    await conn.commit();
    res.json({ success: true, kode_pesanan });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// 7. Endpoint Ambil Pesanan (Membaca kolom asli: o.qty, o.alamat, o.status)
app.get('/api/orders', async (req, res) => {
  try {
    const customerId = req.query.customer_id || '';
    const customerWa = req.query.wa || '';
    const isAdmin = req.headers['x-admin-pin'] === ADMIN_PIN || req.query.role === 'admin';

    if (!isAdmin && !customerId && !customerWa) {
      return res.json([]);
    }

    let query = `
      SELECT 
        o.id,
        o.kode_pesanan,
        o.customer_id,
        COALESCE(c.nama, 'Pelanggan') AS customerName,
        COALESCE(c.no_whatsapp, '-') AS customerWa,
        CASE 
          WHEN o.alamat IS NULL OR TRIM(o.alamat) = '' OR TRIM(o.alamat) = '0' 
          THEN COALESCE(c.alamat, '-') 
          ELSE o.alamat 
        END AS address,
        COALESCE(m.nama_menu, 'Menu Pre-Order') AS menuName,
        o.qty AS qty,
        o.total_harga AS totalPrice,
        COALESCE(NULLIF(TRIM(o.status), ''), 'Menunggu') AS status,
        o.created_at AS createdAt
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN menus m ON o.menu_id = m.id
    `;

    let params = [];
    if (!isAdmin) {
      query += ` WHERE (o.customer_id = ? OR (? <> '' AND c.no_whatsapp = ?))`;
      params.push(customerId, customerWa, customerWa);
    }

    query += ` ORDER BY o.id DESC`;

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Endpoint Tandai Pesanan Selesai (Admin) -> Update kolom status menjadi 'Selesai'
app.put('/api/orders/:id/done', async (req, res) => {
  try {
    await pool.query("UPDATE orders SET status = 'Selesai' WHERE id = ?", [req.params.id]);
    // Jika kolom status_pengiriman masih ada di tabel, ikut di-update agar sinkron
    try {
      await pool.query("UPDATE orders SET status_pengiriman = 'Selesai' WHERE id = ?", [req.params.id]);
    } catch (_) {}
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Endpoint Hapus Pesanan (Admin)
app.delete('/api/orders/:id', async (req, res) => {
  try {
    await pool.query("DELETE FROM orders WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Server berjalan di http://localhost:3000'));