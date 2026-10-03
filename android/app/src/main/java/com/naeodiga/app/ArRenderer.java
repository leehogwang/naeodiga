package com.naeodiga.app;

import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;
import com.google.ar.core.Pose;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/** 카메라 영상 + 경로 위 3D 화살표 + 점. 장면 엔진 없이 GLES2만 쓴다. */
final class ArRenderer {
    int texture;
    private int backgroundProgram;
    private int arrowProgram;
    private FloatBuffer chevron;
    private int chevronVertices;
    private int pathProgram;
    private final FloatBuffer quad = buffer(-1, -1, 1, -1, -1, 1, 1, 1);
    private final FloatBuffer uv = buffer(0, 0, 1, 0, 0, 1, 1, 1);
    private final float[] view = new float[16];
    private final float[] projection = new float[16];
    private final float[] vp = new float[16];

    void create() {
        int[] textures = new int[1];
        GLES20.glGenTextures(1, textures, 0);
        texture = textures[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        backgroundProgram = program("attribute vec2 position; attribute vec2 uv; varying vec2 tex;"
                        + "void main(){gl_Position=vec4(position,0.,1.);tex=uv;}",
                "#extension GL_OES_EGL_image_external : require\nprecision mediump float;"
                        + "uniform samplerExternalOES camera; varying vec2 tex;"
                        + "void main(){gl_FragColor=texture2D(camera,tex);}");
        float[] mesh = ChevronMesh.build();
        chevron = buffer(mesh);
        chevronVertices = mesh.length / 6;
        arrowProgram = program("attribute vec3 position; attribute vec3 normal; uniform mat4 vp; uniform mat4 model; varying vec3 n; varying float top;"
                        + "void main(){gl_Position=vp*model*vec4(position,1.);n=mat3(model)*normal;top=step(.5,normal.y);}",
                "precision mediump float; varying vec3 n; varying float top; uniform float alpha;"
                        + "void main(){float l=.7+.3*max(dot(normalize(n),normalize(vec3(.3,1.,.2))),0.);"
                        + "vec3 c=mix(vec3(.93,.96,1.),vec3(.1,.42,1.),top);gl_FragColor=vec4(c*l,alpha);}");
        // Guidance dots shrink with distance so a floor path reads as a line going away.
        pathProgram = program("attribute vec3 position; uniform mat4 vp; uniform float size;"
                        + "void main(){gl_Position=vp*vec4(position,1.);gl_PointSize=clamp(size/gl_Position.w,3.,90.);}",
                "precision mediump float; uniform vec3 color;"
                        + "void main(){if(distance(gl_PointCoord,vec2(.5))>.5)discard;gl_FragColor=vec4(color,.9);}");
    }

    /** World-space points (x,y,z packed) drawn as round dots; sizeAt1m is the pixel size one metre away. */
    void points(float[] xyz, int count, float r, float g, float b, float sizeAt1m) {
        if (count == 0) return;
        FloatBuffer data = buffer(java.util.Arrays.copyOf(xyz, count * 3));
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA);
        GLES20.glUseProgram(pathProgram);
        attribute(pathProgram, "position", data, 3);
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(pathProgram, "vp"), 1, false, vp, 0);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(pathProgram, "size"), sizeAt1m);
        GLES20.glUniform3f(GLES20.glGetUniformLocation(pathProgram, "color"), r, g, b);
        GLES20.glDrawArrays(GLES20.GL_POINTS, 0, count);
        GLES20.glDisable(GLES20.GL_BLEND);
    }

    /** 바닥 위 (x,y,z)에 yaw(라디안, +Z 기준)로 쉐브론 하나. scale 1 = 폭 0.84m. */
    void arrow(float x, float y, float z, float yaw, float scale, float alpha) {
        float[] model = new float[16];
        android.opengl.Matrix.setIdentityM(model, 0);
        android.opengl.Matrix.translateM(model, 0, x, y, z);
        android.opengl.Matrix.rotateM(model, 0, (float)Math.toDegrees(yaw), 0, 1, 0);
        android.opengl.Matrix.scaleM(model, 0, scale, scale, scale);
        GLES20.glEnable(GLES20.GL_DEPTH_TEST);
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA);
        GLES20.glUseProgram(arrowProgram);
        int position = GLES20.glGetAttribLocation(arrowProgram, "position"), normal = GLES20.glGetAttribLocation(arrowProgram, "normal");
        chevron.position(0);
        GLES20.glVertexAttribPointer(position, 3, GLES20.GL_FLOAT, false, 24, chevron);
        GLES20.glEnableVertexAttribArray(position);
        chevron.position(3);
        GLES20.glVertexAttribPointer(normal, 3, GLES20.GL_FLOAT, false, 24, chevron);
        GLES20.glEnableVertexAttribArray(normal);
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(arrowProgram, "vp"), 1, false, vp, 0);
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(arrowProgram, "model"), 1, false, model, 0);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(arrowProgram, "alpha"), alpha);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, chevronVertices);
        GLES20.glDisable(GLES20.GL_BLEND);
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
    }

    void draw(Frame frame) {
        if (frame.getTimestamp() == 0) return;
        quad.position(0);
        uv.position(0);
        frame.transformCoordinates2d(Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
                quad, Coordinates2d.TEXTURE_NORMALIZED, uv);
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glClear(GLES20.GL_DEPTH_BUFFER_BIT);
        GLES20.glUseProgram(backgroundProgram);
        attribute(backgroundProgram, "position", quad, 2);
        attribute(backgroundProgram, "uv", uv, 2);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture);
        GLES20.glUniform1i(GLES20.glGetUniformLocation(backgroundProgram, "camera"), 0);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        frame.getCamera().getViewMatrix(view, 0);
        frame.getCamera().getProjectionMatrix(projection, 0, .05f, 100f);
        android.opengl.Matrix.multiplyMM(vp, 0, projection, 0, view, 0);
    }

    private static void attribute(int program, String name, FloatBuffer data, int size) {
        int location = GLES20.glGetAttribLocation(program, name);
        data.position(0);
        GLES20.glVertexAttribPointer(location, size, GLES20.GL_FLOAT, false, 0, data);
        GLES20.glEnableVertexAttribArray(location);
    }

    private static FloatBuffer buffer(float... values) {
        FloatBuffer result = ByteBuffer.allocateDirect(values.length * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer();
        result.put(values).position(0);
        return result;
    }

    private static int program(String vertex, String fragment) {
        int result = GLES20.glCreateProgram();
        GLES20.glAttachShader(result, shader(GLES20.GL_VERTEX_SHADER, vertex));
        GLES20.glAttachShader(result, shader(GLES20.GL_FRAGMENT_SHADER, fragment));
        GLES20.glLinkProgram(result);
        int[] status = new int[1];
        GLES20.glGetProgramiv(result, GLES20.GL_LINK_STATUS, status, 0);
        if (status[0] == 0) throw new IllegalStateException(GLES20.glGetProgramInfoLog(result));
        return result;
    }

    private static int shader(int kind, String source) {
        int result = GLES20.glCreateShader(kind);
        GLES20.glShaderSource(result, source);
        GLES20.glCompileShader(result);
        int[] status = new int[1];
        GLES20.glGetShaderiv(result, GLES20.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0) throw new IllegalStateException(GLES20.glGetShaderInfoLog(result));
        return result;
    }
}
