-- ──────────────────────────────────────────────────────────────
-- Test data: Create sample shop and products for testing
-- Run this after running supabase_schema.sql
-- ──────────────────────────────────────────────────────────────

-- Create a test admin
INSERT INTO public.admins (username, password_hash) VALUES 
('admin', '$2a$10$dXJ3SVcuSjY0dGZ5anpLGO8V0b1FuLFCR8gYOWIa.G2Xqt/CihLNi')  -- password: admin123
ON CONFLICT (username) DO NOTHING;

-- Create active shops
INSERT INTO public.shops (phone, password_hash, shop_name, city, status, telegram, description) VALUES 
('+992901234567', '$2a$10$dXJ3SVcuSjY0dGZ5anpLGO8V0b1FuLFCR8gYOWIa.G2Xqt/CihLNi', 'Тестовый магазин цветов', 'Душанбе', 'active', 'https://t.me/test_shop', 'Свежие цветочные композиции и букеты'),
('+992900000001', '$2a$10$dXJ3SVcuSjY0dGZ5anpLGO8V0b1FuLFCR8gYOWIa.G2Xqt/CihLNi', 'Душанбинский букет', 'Душанбе', 'active', 'https://t.me/shop_001', 'Лучшие букеты для праздников и подарков')
ON CONFLICT (phone) DO NOTHING;

-- Create test active products for shops and eco sellers
INSERT INTO public.products (title, description, category, price, city, seller_name, seller_phone, status, slug, photos, listing_type, shop_name) VALUES 
('Букет красных роз', 'Прекрасный букет из 15 свежих красных роз', 'bouquet', 250, 'Душанбе', 'Тестовый магазин', '+992901234567', 'active', 'buket-krasnyh-roz', ARRAY['https://via.placeholder.com/400x300?text=Roses'], 'shop', 'Тестовый магазин'),
('Корзина с тюльпанами', 'Яркая корзина с разноцветными тюльпанами', 'basket', 300, 'Душанбе', 'Тестовый магазин', '+992901234567', 'active', 'korzina-s-tyulpanami', ARRAY['https://via.placeholder.com/400x300?text=Tulips'], 'shop', 'Тестовый магазин'),
('Букет из подсолнухов', 'Солнечный букет из свежих подсолнухов', 'bouquet', 200, 'Душанбе', 'Тестовый магазин', '+992901234567', 'active', 'buket-iz-podsolnuhov', ARRAY['https://via.placeholder.com/400x300?text=Sunflowers'], 'shop', 'Тестовый магазин'),
('Корзина фруктов и цветов', 'Красивая комбинация цветов и спелых фруктов', 'basket', 400, 'Душанбе', 'Тестовый магазин', '+992901234567', 'active', 'korzina-fruktov-i-cvetov', ARRAY['https://via.placeholder.com/400x300?text=Fruits+Flowers'], 'shop', 'Тестовый магазин'),
('Букет пионов', 'Нежный букет из розовых пионов', 'bouquet', 350, 'Душанбе', 'Тестовый магазин', '+992901234567', 'active', 'buket-pionov', ARRAY['https://via.placeholder.com/400x300?text=Peonies'], 'shop', 'Тестовый магазин'),
('Авторский букет ландышей', 'Изящный букет из белых ландышей для особого случая', 'bouquet', 280, 'Душанбе', 'Душанбинский букет', '+992900000001', 'active', 'buket-landyshej', ARRAY['https://via.placeholder.com/400x300?text=Lilies'], 'shop', 'Душанбинский букет'),
('Оригинальный букет хризантем', 'Яркий букет из свежих хризантем', 'bouquet', 320, 'Душанбе', 'Душанбинский букет', '+992900000001', 'active', 'buket-hrizantem', ARRAY['https://via.placeholder.com/400x300?text=Chrysanthemums'], 'shop', 'Душанбинский букет'),
('Экологичный букет из пионов', 'Букет от частного продавца с натуральной упаковкой', 'bouquet', 220, 'Душанбе', 'Частный цветочник', '+992911111222', 'active', 'eko-buket-pionov', ARRAY['https://via.placeholder.com/400x300?text=Eco+Peonies'], 'eco', NULL),
('Эко-кашпо с травами', 'Ручная работа, эко-подарок для дома', 'bear', 180, 'Душанбе', 'Частный цветочник', '+992911111222', 'active', 'eko-kashpo-travy', ARRAY['https://via.placeholder.com/400x300?text=Eco+Herbs'], 'eco', NULL)
ON CONFLICT (slug) DO NOTHING;

SELECT COUNT(*) as shops_count FROM public.shops WHERE status = 'active';
SELECT COUNT(*) as products_count FROM public.products WHERE status = 'active';
SELECT COUNT(*) as admins_count FROM public.admins;
