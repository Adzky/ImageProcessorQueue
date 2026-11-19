<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreImageRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * Size is checked before type so an oversized file always reports its size.
     * `mimes`/`mimetypes` sniff the file content, so a renamed text file is rejected.
     */
    public function rules(): array
    {
        return [
            'image' => [
                'bail',
                'required',
                'file',
                'max:'.config('images.max_upload_kb'),
                'mimes:jpg,jpeg,png,webp',
                'mimetypes:image/jpeg,image/png,image/webp',
            ],
        ];
    }

    public function messages(): array
    {
        $type = 'File must be a JPG, PNG or WebP image.';

        return [
            'image.required' => 'Please choose an image to upload.',
            'image.file' => 'The upload failed — the file may be larger than 20 MB.',
            'image.uploaded' => 'The upload failed — the file may be larger than 20 MB.',
            'image.max' => 'File is larger than 20 MB.',
            'image.mimes' => $type,
            'image.mimetypes' => $type,
        ];
    }
}
