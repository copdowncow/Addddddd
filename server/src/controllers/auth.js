'use strict';

const { q } = require('../db/supabase');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Укажите логин и пароль' });
  }

  try {
    const admin = await q(client =>
      client
        .from('admins')
        .select('id, username, password_hash')
        .eq('username', username)
        .maybeSingle()
    );

    if (!admin) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    // Сессия никогда не истекает — expiresIn не указан
    const token = jwt.sign(
      { id: admin.id, username: admin.username },
      process.env.JWT_SECRET
    );

    res.json({
      token,
      admin: { id: admin.id, username: admin.username }
    });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
};

module.exports.changePassword = async (req, res) => {
  const { current_password, new_password } = req.body;
  const adminId = req.admin.id;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Укажите текущий и новый пароль' });
  }

  try {
    const admin = await q(client =>
      client
        .from('admins')
        .select('password_hash')
        .eq('id', adminId)
        .maybeSingle()
    );

    if (!admin) {
      return res.status(404).json({ error: 'Админ не найден' });
    }

    const valid = await bcrypt.compare(current_password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Текущий пароль неверен' });
    }

    const hash = await bcrypt.hash(new_password, 10);

    await q(client =>
      client
        .from('admins')
        .update({
          password_hash: hash,
          updated_at: new Date().toISOString()
        })
        .eq('id', adminId)
    );

    res.json({ message: 'Пароль успешно изменён' });

  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
};
