'use client';

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { fetchUploadConfig } from './api';

export interface UploadConfigState {
  maxChunkSize: number;
  maxConcurrentChunks: number;
  loaded: boolean;
}

const initialState: UploadConfigState = {
  maxChunkSize: 19 * 1024 * 1024,  // default ~19 MB
  maxConcurrentChunks: 3,           // default
  loaded: false,
};

export const loadUploadConfig = createAsyncThunk(
  'uploadConfig/load',
  async (_, { getState }) => {
    const state = getState() as { uploadConfig: UploadConfigState };
    // Đã fetch rồi thì không fetch lại
    if (state.uploadConfig.loaded) {
      return {
        maxChunkSize: state.uploadConfig.maxChunkSize,
        maxConcurrentChunks: state.uploadConfig.maxConcurrentChunks,
      };
    }
    const data = await fetchUploadConfig();
    return {
      maxChunkSize: data.maxChunkSize,
      maxConcurrentChunks: data.maxConcurrentChunks,
    };
  },
);

const uploadConfigSlice = createSlice({
  name: 'uploadConfig',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(loadUploadConfig.fulfilled, (state, action) => {
      state.maxChunkSize = action.payload.maxChunkSize;
      state.maxConcurrentChunks = action.payload.maxConcurrentChunks;
      state.loaded = true;
    });
  },
});

export default uploadConfigSlice.reducer;
