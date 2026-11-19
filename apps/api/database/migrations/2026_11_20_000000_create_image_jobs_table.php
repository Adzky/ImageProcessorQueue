<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('image_jobs', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('status', 16)->default('pending')->index();

            $table->string('original_name');
            $table->string('original_mime', 32);
            $table->unsignedBigInteger('original_size');
            $table->string('original_path');
            $table->unsignedInteger('original_width')->nullable();
            $table->unsignedInteger('original_height')->nullable();

            $table->string('result_path')->nullable();
            $table->unsignedBigInteger('result_size')->nullable();
            $table->unsignedInteger('result_width')->nullable();
            $table->unsignedInteger('result_height')->nullable();

            // Queue attempt number of the delivery that currently owns the job (claim token).
            $table->unsignedSmallInteger('attempts')->default(0);

            $table->string('error_code', 32)->nullable();
            $table->text('error_message')->nullable();

            $table->timestamp('started_at')->nullable();
            $table->timestamp('completed_at')->nullable();
            $table->timestamp('failed_at')->nullable();
            $table->timestamp('expired_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('image_jobs');
    }
};
