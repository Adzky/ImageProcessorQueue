CREATE TABLE "image_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"original_mime" varchar(32) NOT NULL,
	"original_size" bigint NOT NULL,
	"original_path" varchar(255) NOT NULL,
	"original_width" integer,
	"original_height" integer,
	"result_path" varchar(255),
	"result_size" bigint,
	"result_width" integer,
	"result_height" integer,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error_code" varchar(32),
	"error_message" text,
	"started_at" timestamp (0),
	"completed_at" timestamp (0),
	"failed_at" timestamp (0),
	"expired_at" timestamp (0),
	"created_at" timestamp (0) DEFAULT now() NOT NULL,
	"updated_at" timestamp (0) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "image_jobs_status_index" ON "image_jobs" USING btree ("status");