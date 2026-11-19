<?php

use App\Http\Controllers\ImageJobController;
use Illuminate\Support\Facades\Route;

Route::post('/images', [ImageJobController::class, 'store']);
Route::get('/images/{imageJob}', [ImageJobController::class, 'show'])->whereUuid('imageJob');
Route::get('/images/{imageJob}/download', [ImageJobController::class, 'download'])->whereUuid('imageJob');
