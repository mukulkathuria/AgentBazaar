-- The return window that applied at the time of sale, so later catalog edits or archiving cannot change it.
ALTER TABLE order_lines ADD COLUMN return_window_days int NOT NULL DEFAULT 0 CHECK (return_window_days BETWEEN 0 AND 90);
