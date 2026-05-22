# Database Migrations Guide

## Overview
This directory contains SQL migration files that set up and update the database schema.

## Issue Explanation

The application was showing "0 публикаций" (0 publications) and database login errors because the `shops` and `orders` tables were missing from the Supabase database.

### Root Causes:
1. **Missing `shops` table** - The application code references `shops` table for:
   - Shop registration and authentication
   - Identifying which sellers are registered shops vs. eco sellers
   - Filtering products by shop
   - Displaying shop profiles with publication counts

2. **Missing `orders` table** - Referenced throughout the application for:
   - Order management
   - Order status tracking
   - Chat functionality

3. **Missing related tables** - `chat_messages`, `chat_sessions`, `platform_settings`

## Migration Instructions

### Step 1: Complete Database Setup

If setting up from scratch OR if tables are completely missing, run in Supabase SQL Editor:

```sql
-- Run the complete schema file
-- Copy contents of: supabase_schema_complete.sql
```

Or if you already have some tables and just need to add missing ones:

```sql
-- Run first migration (creates missing tables)
-- Copy contents of: 001_create_shops_orders_chat.sql

-- Then run commission/chat migration
-- Copy contents of: 002_commission_chat_taxi.sql
```

### Step 2: Verify Installation

After running the migrations, verify all tables exist:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public';
```

You should see:
- `admins` ✓
- `products` ✓
- `shops` ✓
- `orders` ✓
- `inquiries` ✓
- `chat_messages` ✓
- `chat_sessions` ✓
- `platform_settings` ✓

### Step 3: Test the Fixes

#### Test 1: Admin Login
- Go to admin login page
- Enter any username/password
- You should see proper error messages (not database connection errors)

#### Test 2: Shop Publications
- Create a shop listing
- Go to shop profile
- Should display the correct number of publications (not 0)

#### Test 3: Shop Login/Registration
- Shop should be able to register
- Shop should be able to log in after approval

## File Descriptions

- **001_create_shops_orders_chat.sql** - Creates missing shops, orders, chat tables
- **002_commission_chat_taxi.sql** - Adds commission system and delivery features (additive)
- **supabase_schema_complete.sql** - Complete database schema (use if starting fresh)
- **supabase_schema.sql** - Original schema (needs to be replaced or run complete schema)

## Common Issues & Solutions

### Issue: "Неверный логин или пароль" on admin/shop login
**Solution:** Missing `shops` table. Run migration 001.

### Issue: "0 публикаций" showing everywhere
**Solution:** Missing `shops` table prevents proper product classification. Run migration 001.

### Issue: Chat features not working
**Solution:** Missing `chat_messages` and `chat_sessions` tables. Run migration 001.

### Issue: Error when running migrations
1. Check that you're in the correct Supabase project
2. Make sure SQL is being run in the SQL Editor, not through the API
3. Copy the entire SQL file content and paste into the editor
4. Execute the entire script (don't execute line by line)

## Next Steps

After migrations are applied:
1. Restart the server
2. Test all features
3. If issues persist, check server logs for connection errors

## Additional Resources

- Supabase Documentation: https://supabase.com/docs
- Project Configuration: Check `.env` file for correct SUPABASE_URL and SUPABASE_SERVICE_KEY
