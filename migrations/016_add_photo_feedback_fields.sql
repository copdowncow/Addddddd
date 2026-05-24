-- Migration 016: Add photo feedback fields to orders table
-- Adds fields for tracking customer photo approval/feedback

ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo_approved BOOLEAN DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo_feedback TEXT DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo_approved_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo_feedback_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo_sent_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN orders.photo_approved IS 'Customer photo approval: true=liked, false=disliked, null=no response yet';
COMMENT ON COLUMN orders.photo_feedback IS 'Customer feedback text when photo is disliked';
COMMENT ON COLUMN orders.photo_approved_at IS 'Timestamp when customer approved the photo';
COMMENT ON COLUMN orders.photo_feedback_at IS 'Timestamp when customer sent feedback';
